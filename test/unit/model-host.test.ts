/**
 * The model host: one detached process that keeps local models loaded for the
 * short-lived processes that call them. ADR 01017.
 *
 * Everything here is real except the inference. Each test spawns the real
 * host from `src/` (through `test/support/fake-model-host.mjs`), talks to it
 * over a real named pipe or Unix socket in a temporary runtime directory, and
 * the host forks the real worker, which loads `fake-llama-backend.mjs`. The
 * fake's log records each model load, so "reused" is counted, not assumed.
 *
 * Timings are generous: a slow CI runner boots a TypeScript host in seconds.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  InferenceError,
  LlamaCppProvider,
  ModelHostBusyError,
  disposeLlamaModels,
  leaseModelHost,
  modelHostStatus,
  releaseModelHost,
} from "../../src/index.js";
import type { CompleteJSONRequest, LlamaCppProviderOptions } from "../../src/index.js";
import {
  llamaWorkerPids,
  resetLlamaWorkers,
  setLlamaWorkerBackend,
} from "../../src/providers/llama-host.js";
import { modelHostPaths, setModelHostEntry } from "../../src/providers/model-host.js";

const HOOKS = pathToFileURL(resolve("test/support/ts-hooks.mjs")).href;
const FIXTURE = pathToFileURL(resolve("test/support/fake-llama-backend.mjs")).href;
const EXEC_ARGV = [
  "--import",
  HOOKS,
  "--experimental-transform-types",
  "--disable-warning=ExperimentalWarning",
];
const TEST_TIMEOUT = 90_000;
const POLL = { timeout: 30_000, interval: 100 };

const MODEL = "gemma-4-e4b";
const OTHER = "qwen3.5-4b";

let dir: string;
let log: string;
let warn: MockInstance<typeof console.warn>;
const savedRuntimeDir = process.env["INFERENCE_RUNTIME_DIR"];

function configure(config: Record<string, unknown>): void {
  process.env["FAKE_LLAMA"] = JSON.stringify({ log, ...config });
}

function events(kind: "init" | "load" | "prompt"): { pid: number; detail: string }[] {
  let text = "";
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${kind} `))
    .map((line) => {
      const [, , pid, detail = ""] = line.split(" ");
      return { pid: Number(pid), detail: decodeURIComponent(detail) };
    });
}

function request(user: string): CompleteJSONRequest {
  return { system: "You grade claims.", user, schema: { type: "object" }, temperature: 0 };
}

function provider(options: LlamaCppProviderOptions = {}, model = MODEL): LlamaCppProvider {
  return new LlamaCppProvider(model, { modelsDirectory: dir, host: "spawn", ...options });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The host's status, which the test then insists is there. */
async function status() {
  const s = await modelHostStatus();
  if (!s) throw new Error("no model host is running");
  return s;
}

/** Run the separate client process; resolve with what it printed. */
function otherProcess(options: Record<string, unknown>, user: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [...EXEC_ARGV, resolve("test/support/model-host-client.mjs")],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          MODEL_HOST_CLIENT: JSON.stringify({ model: MODEL, options, user }),
        },
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.once("exit", (code) => (code === 0 ? done(out) : fail(new Error(err))));
  });
}

/** Send raw frames on a fresh socket; resolve with what came back before it closed. */
function rawExchange(frames: string): Promise<string> {
  return new Promise((done) => {
    const socket = connect(modelHostPaths().socket);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (c: string) => (received += c));
    socket.on("error", () => undefined);
    socket.on("close", () => done(received));
    socket.on("connect", () => socket.write(frames));
  });
}

beforeEach(async () => {
  await disposeLlamaModels();
  await resetLlamaWorkers();
  dir = mkdtempSync(join(tmpdir(), "inference-host-"));
  log = join(dir, "events.log");
  process.env["INFERENCE_RUNTIME_DIR"] = join(dir, "runtime");
  configure({});
  setModelHostEntry({ path: resolve("test/support/fake-model-host.mjs"), execArgv: EXEC_ARGV });
  // For the calls that fall back to a worker of this process's own.
  setLlamaWorkerBackend({
    moduleUrl: FIXTURE,
    resolveModelFile: (uri, directory) => Promise.resolve(join(directory, basename(uri))),
  });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  const running = await modelHostStatus().catch(() => null);
  await releaseModelHost({ all: true }).catch(() => undefined);
  if (running && isAlive(running.pid)) process.kill(running.pid);
  await disposeLlamaModels();
  await resetLlamaWorkers();
  setLlamaWorkerBackend(undefined);
  setModelHostEntry(undefined);
  warn.mockRestore();
  delete process.env["FAKE_LLAMA"];
  if (savedRuntimeDir === undefined) delete process.env["INFERENCE_RUNTIME_DIR"];
  else process.env["INFERENCE_RUNTIME_DIR"] = savedRuntimeDir;
}, TEST_TIMEOUT);

describe("the model host", () => {
  it("starts on the first call, and a second client process reuses the loaded model", async () => {
    const first = await provider().completeJSON(request("first"));
    expect(first.json).toEqual({ match: "pass", confidence: 0.9, backend: "cuda" });
    // A different process, connecting to the host the first one started.
    const second = await otherProcess({ modelsDirectory: dir, host: "connect" }, "second");
    expect(JSON.parse(second)).toMatchObject({ match: "pass" });

    expect(events("load")).toHaveLength(1);
    expect(events("prompt").map((e) => e.detail)).toEqual(["first", "second"]);
    // Nothing ran in this process's own worker.
    expect(llamaWorkerPids()).toEqual([]);
    const s = await status();
    expect(s.pid).not.toBe(process.pid);
    expect(s.models).toEqual([{ model: MODEL, sessions: 0, queued: 0, idleMs: expect.any(Number) }]);
  }, TEST_TIMEOUT);

  it("runs one request at a time per model, in arrival order", async () => {
    configure({ delayMs: 1_500 });
    const p = provider();
    const a = p.completeJSON(request("A"));
    await expect.poll(() => events("prompt").length, POLL).toBe(1);
    const b = p.completeJSON(request("B"));
    await expect.poll(async () => (await status()).models[0]?.queued, POLL).toBe(1);
    const c = p.completeJSON(request("C"));
    await expect.poll(async () => (await status()).models[0]?.queued, POLL).toBe(2);
    await Promise.all([a, b, c]);
    expect(events("prompt").map((e) => e.detail)).toEqual(["A", "B", "C"]);
    expect(events("load")).toHaveLength(1);
  }, TEST_TIMEOUT);

  it("withdraws a request still queued past its hostWaitMs with ModelHostBusyError", async () => {
    configure({ delayMs: 3_000 });
    const a = provider().completeJSON(request("A"));
    await expect.poll(() => events("prompt").length, POLL).toBe(1);
    const b = provider({ hostWaitMs: 200 }).completeJSON(request("B"));
    await expect(b).rejects.toBeInstanceOf(ModelHostBusyError);
    await expect(b).rejects.toBeInstanceOf(InferenceError);
    await expect(b).rejects.toMatchObject({ name: "ModelHostBusyError" });
    await expect(b).rejects.toThrow(/waited 200 ms in the model host's queue/);
    await expect(a).resolves.toMatchObject({ json: { match: "pass" } });
    expect(events("prompt").map((e) => e.detail)).toEqual(["A"]);
  }, TEST_TIMEOUT);

  it("unloads a model with no lease once it has been idle for its keepAlive, then exits", async () => {
    await provider({ keepAlive: 0 }).completeJSON(request("one"));
    await expect.poll(() => modelHostStatus(), POLL).toBeNull();
    await provider({ keepAlive: 0 }).completeJSON(request("two"));
    await expect.poll(() => modelHostStatus(), POLL).toBeNull();
    const loads = events("load");
    expect(loads).toHaveLength(2);
    // Two hosts, two workers: the first exited when nothing was left loaded.
    expect(new Set(loads.map((l) => l.pid)).size).toBe(2);
  }, TEST_TIMEOUT);

  it("keeps a model loaded within its keepAlive", async () => {
    await provider({ keepAlive: 60_000 }).completeJSON(request("one"));
    await delay(1_000);
    expect((await status()).models).toHaveLength(1);
    await provider({ keepAlive: 60_000 }).completeJSON(request("two"));
    expect(events("load")).toHaveLength(1);
  }, TEST_TIMEOUT);

  it("takes a lease that preloads the model, and holds it", async () => {
    const leased = await leaseModelHost({ model: MODEL, session: "s1", modelsDirectory: dir });
    expect(leased?.pid).toEqual(expect.any(Number));
    expect(events("load")).toHaveLength(1);
    expect(events("prompt")).toHaveLength(0);
    expect((await status()).models).toEqual([
      { model: MODEL, sessions: 1, queued: 0, idleMs: expect.any(Number) },
    ]);
    // A call naming the session renews it; even one asking for no keepAlive of
    // its own leaves the model loaded, because the lease still holds it.
    await provider({ session: "s1", keepAlive: 0 }).completeJSON(request("call"));
    await delay(500);
    expect((await status()).models[0]?.sessions).toBe(1);
    expect(events("load")).toHaveLength(1);
  }, TEST_TIMEOUT);

  it("renews a lease on each call naming its session, and lets it lapse when unused", async () => {
    await leaseModelHost({ model: MODEL, session: "s1", keepAlive: 5_000, modelsDirectory: dir });
    const p = provider({ session: "s1", keepAlive: 0 });
    for (const user of ["1", "2", "3", "4", "5"]) {
      await delay(1_000);
      await p.completeJSON(request(user));
    }
    // Past the lease's own 5 s, but renewed by every call.
    expect((await status()).models[0]?.sessions).toBe(1);
    expect(events("load")).toHaveLength(1);
    // Unused, it lapses; the model's keepAlive is 0, so it unloads and the host exits.
    await expect.poll(() => modelHostStatus(), POLL).toBeNull();
  }, TEST_TIMEOUT);

  it("returns null from leaseModelHost when no host runs and spawn is false", async () => {
    expect(
      await leaseModelHost({ model: MODEL, session: "s1", modelsDirectory: dir, spawn: false }),
    ).toBeNull();
    expect(await modelHostStatus()).toBeNull();
  }, TEST_TIMEOUT);

  it("releases one session's lease, unloading a model only when no other lease holds it", async () => {
    await leaseModelHost({ model: MODEL, session: "s1", keepAlive: 60_000, modelsDirectory: dir });
    await leaseModelHost({ model: MODEL, session: "s2", keepAlive: 60_000, modelsDirectory: dir });
    const { pid } = await status();
    expect(await releaseModelHost({ session: "s1" })).toEqual({
      released: ["s1"],
      unloaded: [],
      hostStopped: false,
    });
    expect((await status()).models[0]?.sessions).toBe(1);
    expect(await releaseModelHost({ session: "nobody" })).toEqual({
      released: [],
      unloaded: [],
      hostStopped: false,
    });
    expect(await releaseModelHost({ session: "s2" })).toEqual({
      released: ["s2"],
      unloaded: [MODEL],
      hostStopped: true,
    });
    expect(await modelHostStatus()).toBeNull();
    await expect.poll(() => isAlive(pid), POLL).toBe(false);
  }, TEST_TIMEOUT);

  it("releases everything and stops the host with { all: true }", async () => {
    await leaseModelHost({ model: MODEL, session: "s1", keepAlive: 60_000, modelsDirectory: dir });
    await provider({ keepAlive: 60_000 }).completeJSON(request("x"));
    const { pid } = await status();
    expect(await releaseModelHost({ all: true })).toEqual({
      released: ["s1"],
      unloaded: [MODEL],
      hostStopped: true,
    });
    expect(await modelHostStatus()).toBeNull();
    await expect.poll(() => isAlive(pid), POLL).toBe(false);
  }, TEST_TIMEOUT);

  it("reports no host, and starts none, from modelHostStatus and releaseModelHost", async () => {
    expect(await modelHostStatus()).toBeNull();
    expect(await releaseModelHost({ all: true })).toEqual({
      released: [],
      unloaded: [],
      hostStopped: false,
    });
    expect(await releaseModelHost({ session: "s1" })).toEqual({
      released: [],
      unloaded: [],
      hostStopped: false,
    });
    expect(await modelHostStatus()).toBeNull();
  }, TEST_TIMEOUT);

  it("closes a connection that does not open with the host's token", async () => {
    await leaseModelHost({ model: MODEL, session: "s1", modelsDirectory: dir });
    const wrong = await rawExchange(`${JSON.stringify({ id: 1, op: "hello", token: "nope" })}\n`);
    expect(JSON.parse(wrong)).toMatchObject({ id: 1, ok: false });
    // Not a hello at all: closed without a word, and nothing else is answered.
    const skipped = await rawExchange(
      `${JSON.stringify({ id: 1, op: "status" })}\n${JSON.stringify({ id: 2, op: "shutdown" })}\n`,
    );
    expect(skipped).toBe("");
    // The host is untouched by either.
    expect((await status()).models[0]?.sessions).toBe(1);
  }, TEST_TIMEOUT);

  it("reclaims a start lock and a socket left by a host that died", async () => {
    const dead = await new Promise<number>((done) => {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      child.once("exit", () => done(child.pid!));
    });
    const paths = modelHostPaths();
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(join(paths.dir, "host.lock"), String(dead));
    if (process.platform !== "win32") writeFileSync(paths.socket, "");
    await provider().completeJSON(request("after"));
    expect((await status()).pid).not.toBe(dead);
  }, TEST_TIMEOUT);

  it("retries once on a new host when the host dies mid-request", async () => {
    configure({ delayMs: 2_000 });
    const call = provider().completeJSON(request("survivor"));
    await expect.poll(() => events("prompt").length, POLL).toBe(1);
    const { pid } = await status();
    process.kill(pid, "SIGKILL");
    await expect(call).resolves.toMatchObject({ json: { match: "pass" } });
    expect(events("prompt").map((e) => e.detail)).toEqual(["survivor", "survivor"]);
    expect((await status()).pid).not.toBe(pid);
  }, TEST_TIMEOUT);

  it("in connect mode, uses a running host", async () => {
    await leaseModelHost({ model: MODEL, session: "s1", modelsDirectory: dir });
    await provider({ host: "connect" }).completeJSON(request("x"));
    expect(events("load")).toHaveLength(1);
    expect(llamaWorkerPids()).toEqual([]);
  }, TEST_TIMEOUT);

  it("in connect mode, falls back to this process's own worker when no host runs", async () => {
    const result = await provider({ host: "connect" }).completeJSON(request("local"));
    expect(result.json).toMatchObject({ match: "pass" });
    expect(llamaWorkerPids()).toHaveLength(1);
    expect(events("prompt")[0]?.pid).toBe(llamaWorkerPids()[0]);
    expect(await modelHostStatus()).toBeNull();
  }, TEST_TIMEOUT);

  it("in connect mode, falls back and retries once when the host dies mid-request", async () => {
    configure({ delayMs: 2_000 });
    await leaseModelHost({ model: MODEL, session: "s1", modelsDirectory: dir });
    const call = provider({ host: "connect" }).completeJSON(request("x"));
    await expect.poll(() => events("prompt").length, POLL).toBe(1);
    const { pid } = await status();
    process.kill(pid, "SIGKILL");
    await expect(call).resolves.toMatchObject({ json: { match: "pass" } });
    expect(llamaWorkerPids()).toHaveLength(1);
    expect(await modelHostStatus()).toBeNull();
  }, TEST_TIMEOUT);

  it("serves decide and stateLimit through the host", async () => {
    configure({ decide: { answers: { "Is it red?": { A: 0.8, B: 0.2 } } } });
    const p = provider();
    const result = await p.decide({
      state: "A red ball.",
      questions: {
        color: { type: "choice", instructions: "Is it red?", criteria: { yes: "", no: "" } },
      },
    });
    expect(result.answers["color"]?.choice).toBe("yes");
    expect(await p.stateLimit()).toBeGreaterThan(0);
    expect(events("load")).toHaveLength(1);
    expect(llamaWorkerPids()).toEqual([]);
  }, TEST_TIMEOUT);

  it("unloads an idle model first when a second one would not fit beside it", async () => {
    // Each model takes 20 GB of a 30 GB budget, so the second does not fit.
    configure({ memory: { total: 30e9, perModel: 20e9 } });
    await provider({ keepAlive: 60_000 }).completeJSON(request("a"));
    await provider({ keepAlive: 60_000 }, OTHER).completeJSON(request("b"));
    expect(events("load").map((e) => e.detail)).toHaveLength(2);
    expect((await status()).models.map((m) => m.model)).toEqual([OTHER]);
  }, TEST_TIMEOUT);

  it("keeps two models loaded when both fit", async () => {
    configure({ memory: { total: 100e9, perModel: 20e9 } });
    await provider({ keepAlive: 60_000 }).completeJSON(request("a"));
    await provider({ keepAlive: 60_000 }, OTHER).completeJSON(request("b"));
    expect((await status()).models.map((m) => m.model).sort()).toEqual([MODEL, OTHER].sort());
  }, TEST_TIMEOUT);
});

describe("the host options", () => {
  it("leave the provider in this process when host is off or unset", async () => {
    await new LlamaCppProvider(MODEL, { modelsDirectory: dir }).completeJSON(request("x"));
    await new LlamaCppProvider(MODEL, { modelsDirectory: dir, host: "off" }).completeJSON(
      request("y"),
    );
    expect(llamaWorkerPids()).toHaveLength(1);
    expect(await modelHostStatus()).toBeNull();
  }, TEST_TIMEOUT);

  it("are validated at construction", () => {
    const make = (options: Record<string, unknown>) => () =>
      new LlamaCppProvider(MODEL, options as LlamaCppProviderOptions);
    expect(make({ host: "always" })).toThrow(
      'llamaCpp.host must be "off", "connect" or "spawn", got "always".',
    );
    expect(make({ keepAlive: -1 })).toThrow(
      "llamaCpp.keepAlive must be a non-negative number of milliseconds, got -1.",
    );
    expect(make({ hostWaitMs: Number.NaN })).toThrow(
      "llamaCpp.hostWaitMs must be a non-negative number of milliseconds, got NaN.",
    );
    expect(make({ session: "" })).toThrow('llamaCpp.session must be a non-empty string, got "".');
  });

  it("validate releaseModelHost's and leaseModelHost's arguments", async () => {
    await expect(releaseModelHost({} as { all: true })).rejects.toThrow(
      "releaseModelHost needs { session } or { all: true }.",
    );
    await expect(leaseModelHost({ model: MODEL, session: "" })).rejects.toThrow(
      'leaseModelHost needs a non-empty session, got "".',
    );
  });
});
