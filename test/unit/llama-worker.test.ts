/**
 * Local inference in a worker process, and the fallback when a GPU backend
 * crashes it. ADR 01012.
 *
 * Everything here is real except the inference: the worker is a forked Node
 * process running `src/providers/llama-worker.ts`, its IPC is Node's, and a
 * crash is a genuine `process.abort()` from `test/support/fake-llama-backend.mjs`,
 * which the worker loads in place of node-llama-cpp. The one test that loads
 * the real node-llama-cpp asserts the contract only, so it stays honest on a
 * machine without the binding.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  InferenceError,
  LlamaCppProvider,
  completeJSONShared,
  completeValidatedJSON,
  defaultLlamaRuntime,
  disposeLlamaModels,
  makeProviderAsync,
} from "../../src/index.js";
import type {
  CompleteJSONRequest,
  DecideRequest,
  LlamaDecideResult,
  LlamaRuntime,
  LlamaSharedResult,
} from "../../src/index.js";
import {
  llamaWorkerPids,
  resetLlamaWorkers,
  setLlamaWorkerBackend,
} from "../../src/providers/llama-host.js";
import { realExec } from "../../src/exec.js";

const FIXTURE = pathToFileURL(resolve("test/support/fake-llama-backend.mjs")).href;
const HOOKS = pathToFileURL(resolve("test/support/ts-hooks.mjs")).href;

const SCHEMA = {
  type: "object",
  properties: {
    match: { type: "string", enum: ["pass", "fail"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    backend: { type: "string" },
  },
  required: ["match", "confidence"],
  additionalProperties: false,
} as const;

const REQUEST: CompleteJSONRequest = {
  system: "You grade claims.",
  user: "Does the doc match?",
  schema: SCHEMA as unknown as Record<string, unknown>,
  temperature: 0,
};

let dir: string;
let log: string;
let warn: MockInstance<typeof console.warn>;
/** The workers' stderr, forwarded by the host — captured, not printed. */
let forwarded: string[];
let stderrWrite: MockInstance<typeof process.stderr.write>;
const savedGpuEnv = process.env["NODE_LLAMA_CPP_GPU"];

function configure(config: Record<string, unknown>): void {
  process.env["FAKE_LLAMA"] = JSON.stringify({ log, ...config });
}

/** The fixture's log, as `[event, backend, pid]` triples. */
function events(kind: "init" | "prompt" | "decide" | "prefix" | "generate"): { backend: string; pid: number }[] {
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
      const [, backend, pid] = line.split(" ");
      return { backend: backend!, pid: Number(pid) };
    });
}

function provider(options: ConstructorParameters<typeof LlamaCppProvider>[1] = {}) {
  return new LlamaCppProvider("gemma-4-e4b", { modelsDirectory: dir, ...options });
}

function warnings(): string[] {
  return warn.mock.calls.map((args) => String(args[0]));
}

beforeEach(async () => {
  await disposeLlamaModels();
  await resetLlamaWorkers();
  dir = mkdtempSync(join(tmpdir(), "inference-worker-"));
  log = join(dir, "events.log");
  delete process.env["NODE_LLAMA_CPP_GPU"];
  configure({});
  setLlamaWorkerBackend({
    moduleUrl: FIXTURE,
    resolveModelFile: (uri, directory) =>
      Promise.resolve(join(directory, basename(uri))),
  });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  forwarded = [];
  stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    forwarded.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  await disposeLlamaModels();
  await resetLlamaWorkers();
  setLlamaWorkerBackend(undefined);
  warn.mockRestore();
  stderrWrite.mockRestore();
  delete process.env["FAKE_LLAMA"];
  if (savedGpuEnv === undefined) delete process.env["NODE_LLAMA_CPP_GPU"];
  else process.env["NODE_LLAMA_CPP_GPU"] = savedGpuEnv;
});

describe("the worker boundary", () => {
  it("answers through the worker, with usage, and never in this process", async () => {
    const result = await provider().completeJSON(REQUEST);
    expect(result.json).toEqual({ match: "pass", confidence: 0.9, backend: "cuda" });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    const [init] = events("init");
    expect(init!.pid).not.toBe(process.pid);
    expect(llamaWorkerPids()).toEqual([init!.pid]);
  });

  it("sizes the context with the worker's tokenizer and training size", async () => {
    // countTokens and trainContextSize now cross IPC; the ADR 01011 sizing must
    // still see them, or a long prompt would get the 8192 default and overflow.
    const runtime = defaultLlamaRuntime();
    const model = await runtime.loadModel(join(dir, "m.gguf"));
    expect(model.trainContextSize).toBe(131_072);
    expect(await model.countTokens!("x".repeat(40))).toBe(10);
    const session = await model.createSession("system", 20_000);
    expect(session.contextSize).toBe(20_000);
    await session.dispose();
  });

  it("hands back plain objects, so a spread copy of a model or session still works", async () => {
    // The in-process runtime returned object literals, and wrappers written
    // against it — the live suite's recording runtime among them — spread
    // them. A class instance would lose its methods to that spread.
    const runtime = defaultLlamaRuntime();
    const model = { ...(await runtime.loadModel(join(dir, "m.gguf"))) };
    expect(await model.countTokens!("x".repeat(8))).toBe(2);
    const session = { ...(await model.createSession("system", 4096)) };
    expect(session.contextSize).toBe(4096);
    const result = await session.prompt("hi", {
      schema: REQUEST.schema,
      temperature: 0,
      thoughtTokens: 0,
    });
    expect(JSON.parse(result.text)).toMatchObject({ match: "pass" });
    await session.dispose();
    await model.dispose();
  });

  it("propagates an ordinary error unchanged, without retrying or replacing the worker", async () => {
    configure({ throwOnPrompt: "context overflow" });
    const p = provider();
    await expect(p.completeJSON(REQUEST)).rejects.toThrow("context overflow");
    await expect(p.completeJSON(REQUEST)).rejects.toThrow("context overflow");
    const pids = new Set(events("prompt").map((e) => e.pid));
    expect(pids.size).toBe(1);
    expect(events("init")).toHaveLength(1);
    expect(warnings()).toEqual([]);
  });

  it("ends the worker on disposeLlamaModels", async () => {
    await provider().completeJSON(REQUEST);
    const [pid] = llamaWorkerPids();
    await disposeLlamaModels();
    expect(llamaWorkerPids()).toEqual([]);
    await expect.poll(() => isAlive(pid!), { timeout: 10_000 }).toBe(false);
  });
});

describe("falling back from a crashing backend", () => {
  it("retries a call that crashed CUDA on Vulkan, and says so once", async () => {
    configure({ abort: { cuda: "prompt" } });
    const result = await provider().completeJSON(REQUEST);
    expect(result.json).toMatchObject({ backend: "vulkan" });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(
      /^inference: llama\.cpp's CUDA backend crashed the local-model worker \(.*ggml-cuda\.cu:106: cuda error\)\. Retrying on Vulkan, and staying on Vulkan for the rest of this process\. Set NODE_LLAMA_CPP_GPU=vulkan \(or llamaCpp\.gpu: "vulkan"\) to start there\.$/,
    );
    // llama.cpp's own output still reaches the user's terminal.
    expect(forwarded.join("")).toContain("ggml-cuda.cu:106: cuda error");
  });

  it("names ggml's abort line, not the backtrace after it", async () => {
    // A real GGML_ABORT prints a backtrace whose frames say "abort" as well;
    // Node's abort report, which the fixture's crash produces, does the same.
    configure({ abort: { cuda: "prompt" } });
    await provider().completeJSON(REQUEST);
    expect(warnings()[0]).toMatch(/\((?:exit code|signal) [^:]+: D:\\a\\.*ggml-cuda\.cu:106: cuda error\)/);
  });

  it("remembers the failed backend for later calls and new providers", async () => {
    configure({ abort: { cuda: "prompt" } });
    await provider().completeJSON(REQUEST);
    await provider().completeJSON(REQUEST);
    const again = await provider().completeJSON(REQUEST);
    expect(again.json).toMatchObject({ backend: "vulkan" });
    expect(events("init").map((e) => e.backend)).toEqual(["cuda", "vulkan"]);
    expect(warnings()).toHaveLength(1);
  });

  it("falls back to the CPU when Vulkan crashes too, and warns about the cost", async () => {
    configure({ abort: { cuda: "prompt", vulkan: "prompt" } });
    const result = await provider().completeJSON(REQUEST);
    expect(result.json).toMatchObject({ backend: "cpu" });
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]).toMatch(
      /Vulkan backend crashed .*Retrying on the CPU, which is much slower/,
    );
  });

  it("records an errored run when every backend crashes", async () => {
    configure({ abort: { cuda: "prompt", vulkan: "prompt", cpu: "prompt" } });
    const run = await completeValidatedJSON({
      provider: provider(),
      system: REQUEST.system,
      user: REQUEST.user,
      schema: REQUEST.schema,
    });
    expect(run.result).toBeUndefined();
    expect(run.error).toMatch(
      /crashed the local-model worker on every backend this machine offers — CUDA \(.*\), Vulkan \(.*\), CPU \(.*\)\. The request was not answered\./,
    );
  }, 30_000); // three backends crash in turn, each a fresh worker; a slow runner needs more than 5s

  it.each(["init", "load"] as const)(
    "falls back from a crash during %s too",
    async (stage) => {
      configure({ abort: { cuda: stage } });
      const result = await provider().completeJSON(REQUEST);
      expect(result.json).toMatchObject({ backend: "vulkan" });
      expect(warnings()).toHaveLength(1);
    },
  );

  it("retries every concurrent call on one replacement worker", async () => {
    configure({ abort: { cuda: "prompt" }, delayMs: 300 });
    const p = provider();
    const results = await Promise.all([
      p.completeJSON(REQUEST),
      p.completeJSON(REQUEST),
      p.completeJSON(REQUEST),
    ]);
    for (const r of results) expect(r.json).toMatchObject({ backend: "vulkan" });
    expect(events("init").map((e) => e.backend)).toEqual(["cuda", "vulkan"]);
    expect(warnings()).toHaveLength(1);
  });

  it("resolves the tier probe through the worker and falls back there too", async () => {
    configure({ abort: { cuda: "init" } });
    const p = await makeProviderAsync({
      provider: "llama-cpp",
      llamaCpp: { modelsDirectory: dir },
    });
    expect(p.modelName()).not.toBe("auto");
    const result = await p.completeJSON(REQUEST);
    expect(result.json).toMatchObject({ backend: "vulkan" });
  });
});

describe("an explicitly chosen backend", () => {
  it("fails loudly instead of switching when llamaCpp.gpu names it", async () => {
    configure({ abort: { cuda: "prompt" } });
    const error = await provider({ gpu: "cuda" })
      .completeJSON(REQUEST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toMatch(
      /^llama\.cpp's CUDA backend crashed the local-model worker \(.*\)\. CUDA was chosen explicitly \(llamaCpp\.gpu: "cuda"\), so the library did not switch backends\. Choose another — NODE_LLAMA_CPP_GPU=vulkan, or false for the CPU — or unset it to let the library fall back on its own\.$/,
    );
    expect(events("init").map((e) => e.backend)).toEqual(["cuda"]);
    expect(warnings()).toEqual([]);
  });

  it("treats NODE_LLAMA_CPP_GPU as an explicit choice", async () => {
    process.env["NODE_LLAMA_CPP_GPU"] = "cuda";
    configure({ abort: { cuda: "prompt" } });
    await expect(provider().completeJSON(REQUEST)).rejects.toThrow(
      /CUDA was chosen explicitly \(NODE_LLAMA_CPP_GPU=cuda\)/,
    );
    expect(events("init").map((e) => e.backend)).toEqual(["cuda"]);
  });

  it("starts on the chosen backend", async () => {
    const result = await provider({ gpu: "vulkan" }).completeJSON(REQUEST);
    expect(result.json).toMatchObject({ backend: "vulkan" });
  });

  it.each(["rocm", "", true, 1])("rejects llamaCpp.gpu %j at construction", (gpu) => {
    expect(() => provider({ gpu: gpu as never })).toThrow(InferenceError);
    expect(() => provider({ gpu: gpu as never })).toThrow(
      /llamaCpp\.gpu must be "auto", "cuda", "vulkan", "metal" or false/,
    );
  });
});

const STATE = "The agent ran `git commit --no-verify`, then wrote a summary.";
const DECIDE: DecideRequest = {
  state: STATE,
  questions: {
    hooks: {
      type: "choice",
      instructions: "Did the agent skip a git hook?",
      criteria: { yes: "It skipped one.", no: "It ran every hook." },
    },
    tests: {
      type: "choice",
      instructions: "Did the agent run the tests?",
      criteria: { yes: "It ran them.", no: "It did not." },
    },
    tone: {
      type: "choice",
      instructions: "How did the agent word its summary?",
      criteria: { plain: "Plainly.", hedged: "With hedges.", absent: "There was none." },
    },
  },
};

/**
 * The fixture's scripted next-token probabilities, keyed by text only that
 * question's prompt holds. Letters take only part of the mass, as on a real
 * model, and the fixture refuses a context holding two questions at once.
 */
function configureDecisions(sequence: string, extra: Record<string, unknown> = {}): void {
  configure({
    decide: {
      sequence,
      answers: {
        "skip a git hook": { A: 0.375, B: 0.125 },
        "run the tests": { B: 0.9 },
        "word its summary": { A: 0.1, C: 0.4 },
      },
    },
    ...extra,
  });
}

/** The real runtime, recording what each session's decide() reported. */
function recordingDecisions(): { runtime: LlamaRuntime; results: LlamaDecideResult[] } {
  const results: LlamaDecideResult[] = [];
  const real = defaultLlamaRuntime();
  return {
    results,
    runtime: {
      ...real,
      async loadModel(path) {
        const model = await real.loadModel(path);
        return {
          ...model,
          async createSession(systemPrompt, contextSize) {
            const session = await model.createSession(systemPrompt, contextSize);
            return {
              ...session,
              async decide(options) {
                const result = await session.decide!(options);
                results.push(result);
                return result;
              },
            };
          },
        };
      },
    },
  };
}

describe("decisions in the worker", () => {
  async function decide(request: DecideRequest = DECIDE) {
    // A fresh worker, so it reads the fixture's configuration as it is now, and
    // no loaded model left by an earlier call bypasses this recording runtime.
    await disposeLlamaModels();
    const { runtime, results } = recordingDecisions();
    const response = await provider({ runtime }).decide(request);
    return { response, result: results[0]! };
  }

  it("answers each question from the next-token probabilities of its letters", async () => {
    configureDecisions("attention");
    const { response } = await decide();
    expect(response.answers["hooks"]).toEqual({
      choice: "yes",
      probabilities: { yes: 0.75, no: 0.25 },
      confidence: 0.75,
    });
    expect(response.answers["tests"]).toEqual({
      choice: "no",
      probabilities: { yes: 0, no: 1 },
      confidence: 1,
    });
    expect(response.answers["tone"]!.choice).toBe("absent");
    expect(response.answers["tone"]!.confidence).toBeCloseTo(0.8);
    expect(response.usage?.inputTokens).toBeGreaterThan(0);
    expect(response.usage?.outputTokens).toBe(0);
    expect(events("decide").map((e) => e.backend)).toEqual(["cuda", "cuda", "cuda"]);
  });

  it("evaluates the shared state once and erases each question after it", async () => {
    configureDecisions("attention");
    const { result } = await decide();
    expect(result.reuse).toBe("erase");
  });

  it("restores a hybrid model's sequence from a checkpoint instead", async () => {
    configureDecisions("attention");
    const erased = await decide();
    configureDecisions("hybrid");
    const restored = await decide();
    expect(restored.result.reuse).toBe("checkpoint");
    expect(restored.response).toEqual(erased.response);
  });

  it("re-evaluates the state per question when the sequence cannot be restored", async () => {
    configureDecisions("attention");
    const erased = await decide();
    configureDecisions("hybrid-without-checkpoints");
    const again = await decide();
    expect(again.result.reuse).toBe("reevaluate");
    // The same answers, at the price of evaluating the state once per question.
    expect(again.response.answers).toEqual(erased.response.answers);
    expect(again.response.usage!.inputTokens).toBeGreaterThan(
      erased.response.usage!.inputTokens + 2 * STATE.length,
    );
  });

  it("reports no reuse for a single question", async () => {
    configureDecisions("hybrid");
    const { result, response } = await decide({
      state: DECIDE.state,
      questions: { hooks: DECIDE.questions["hooks"]! },
    });
    expect(result.reuse).toBeUndefined();
    expect(response.answers["hooks"]!.choice).toBe("yes");
  });

  /** 40 tokens other than the letters, each more likely than `p` of the mass. */
  const crowd = (p: number): Record<string, number> =>
    Object.fromEntries([..."abcdefghijklmnopqrstuvwxyz0123456789!@#$"].map((c) => [c, p]));
  /** How each probe read the distribution: "40" or "all". */
  const readouts = (): string[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("decide "))
      .map((line) => line.split(" ")[3]!);

  it("reads only the 40 most likely tokens, so a letter outside them weighs nothing", async () => {
    configure({
      decide: {
        sequence: "hybrid",
        answers: { "skip a git hook": { A: 0.3, B: 0.001, ...crowd(0.01) } },
      },
    });
    const { response } = await decide({
      state: STATE,
      questions: { hooks: DECIDE.questions["hooks"]! },
    });
    // B is not among the 40, so it weighs 0, and the letters present still sum to 1.
    expect(response.answers["hooks"]).toEqual({
      choice: "yes",
      probabilities: { yes: 1, no: 0 },
      confidence: 1,
    });
    expect(readouts()).toEqual(["40"]);
  });

  it("reads the whole distribution when no letter is among the 40, so a decision is never empty", async () => {
    configure({
      decide: {
        sequence: "hybrid",
        answers: {
          "skip a git hook": { A: 0.001, B: 0.003, ...crowd(0.02) },
          "run the tests": { B: 0.9 },
        },
      },
    });
    const { response, result } = await decide({
      state: STATE,
      questions: { hooks: DECIDE.questions["hooks"]!, tests: DECIDE.questions["tests"]! },
    });
    expect(response.answers["hooks"]!.choice).toBe("no");
    expect(response.answers["hooks"]!.probabilities["no"]).toBeCloseTo(0.75);
    expect(response.answers["tests"]!.choice).toBe("no");
    expect(readouts()).toEqual(["40", "all", "40"]);
    // The re-read went back to the shared state the way the next question does.
    expect(result.reuse).toBe("checkpoint");
  });

  it("falls back from a backend that crashes mid-decision", async () => {
    configureDecisions("hybrid", { abort: { cuda: "decide" } });
    const { response } = await decide();
    expect(response.answers["tests"]!.choice).toBe("no");
    expect(events("decide").map((e) => e.backend)).toEqual(["cuda", "vulkan", "vulkan", "vulkan"]);
    expect(warnings()).toHaveLength(1);
  });
});

const TURN = "The agent ran `git commit --no-verify`, then wrote a summary without hedges.\n\n";
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    followed: { type: "integer", minimum: 0, maximum: 100 },
    "not-followed": { type: "integer", minimum: 0, maximum: 100 },
    "not-applicable": { type: "integer", minimum: 0, maximum: 100 },
  },
  required: ["followed", "not-followed", "not-applicable"],
  additionalProperties: false,
};
const RULES = [
  "Rule: never skip git hooks.",
  "Rule: run the tests before committing.",
  "Rule: word summaries plainly.",
  "Rule: answer in French.",
];
const verdict = (followed: number, not: number, na: number): string =>
  JSON.stringify({ followed, "not-followed": not, "not-applicable": na });

/**
 * The fixture's scripted generations, keyed by text only that rule holds. The
 * fixture refuses a context holding two rules at once, so a missed erase fails.
 */
function configureShared(
  sequence: string,
  outputs: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): void {
  configure({
    sequence,
    shared: {
      outputs: {
        "skip git hooks": verdict(5, 90, 5),
        "run the tests": verdict(10, 20, 70),
        "summaries plainly": verdict(85, 10, 5),
        "in French": verdict(0, 95, 5),
        ...outputs,
      },
    },
    ...extra,
  });
}

/** The real runtime, recording what each session's completeShared() reported. */
function recordingShared(): { runtime: LlamaRuntime; results: LlamaSharedResult[] } {
  const results: LlamaSharedResult[] = [];
  const real = defaultLlamaRuntime();
  return {
    results,
    runtime: {
      ...real,
      async loadModel(path) {
        const model = await real.loadModel(path);
        return {
          ...model,
          async createSession(systemPrompt, contextSize) {
            const session = await model.createSession(systemPrompt, contextSize);
            return {
              ...session,
              async completeShared(options) {
                const result = await session.completeShared!(options);
                results.push(result);
                return result;
              },
            };
          },
        };
      },
    },
  };
}

// Each test forks a fresh worker, twice for the re-evaluation case: generous for slow runners.
describe("shared-prefix JSON in the worker", { timeout: 60_000 }, () => {
  async function shared(
    items: string[] = RULES,
    options: ConstructorParameters<typeof LlamaCppProvider>[1] = {},
  ) {
    await disposeLlamaModels();
    const { runtime, results } = recordingShared();
    const response = await completeJSONShared(provider({ runtime, ...options }), {
      system: "You judge one agent turn against one rule.",
      shared: TURN,
      items,
      schema: VERDICT_SCHEMA,
    });
    return { response, result: results[0] };
  }

  it("answers each item with its own validated object, in item order", async () => {
    configureShared("attention");
    const { response } = await shared();
    expect(response.answers).toEqual([
      { json: { followed: 5, "not-followed": 90, "not-applicable": 5 } },
      { json: { followed: 10, "not-followed": 20, "not-applicable": 70 } },
      { json: { followed: 85, "not-followed": 10, "not-applicable": 5 } },
      { json: { followed: 0, "not-followed": 95, "not-applicable": 5 } },
    ]);
    expect(response.usage?.inputTokens).toBeGreaterThan(0);
    expect(response.usage?.outputTokens).toBeGreaterThan(0);
    expect(events("generate")).toHaveLength(RULES.length);
  });

  it.each([
    ["attention", "erase"],
    ["hybrid", "checkpoint"],
  ])("evaluates the shared prefix once on a %s sequence, reusing it by %s", async (sequence, reuse) => {
    configureShared(sequence);
    const { response, result } = await shared();
    expect(events("prefix")).toHaveLength(1);
    expect(response.reuse).toBe(reuse);
    expect(result?.reuse).toBe(reuse);
  });

  it("re-evaluates the prefix per item when the sequence cannot be restored, with the same answers", async () => {
    configureShared("attention");
    const erased = await shared();
    rmSync(log, { force: true });
    configureShared("hybrid-without-checkpoints");
    const again = await shared();
    expect(again.response.reuse).toBe("reevaluate");
    expect(events("prefix")).toHaveLength(RULES.length);
    expect(again.response.answers).toEqual(erased.response.answers);
    expect(again.response.usage!.inputTokens).toBeGreaterThan(
      erased.response.usage!.inputTokens + (RULES.length - 1) * TURN.length,
    );
  });

  it("reports no reuse for a single item", async () => {
    configureShared("hybrid");
    const { response } = await shared([RULES[0]!]);
    expect(response.reuse).toBeUndefined();
    expect(response.answers).toEqual([
      { json: { followed: 5, "not-followed": 90, "not-applicable": 5 } },
    ]);
  });

  it("stops generating once the object is complete", async () => {
    configureShared("attention", {
      "skip git hooks": `${verdict(5, 90, 5)}\n\n\n\ntrailing text`,
    });
    const { response } = await shared();
    expect(response.answers[0]).toEqual({
      json: { followed: 5, "not-followed": 90, "not-applicable": 5 },
    });
  });

  it("records a failed item as an error and answers the rest", async () => {
    configureShared("hybrid", {
      "skip git hooks": `{"followed": 5, "not-followed": 900, "not-applicable": 5}`,
      "run the tests": "not json at all",
      "summaries plainly": { throw: "grammar evaluation failed" },
    });
    const { response } = await shared();
    expect(response.answers[0]).toEqual({
      error: expect.stringMatching(
        /^Response failed schema validation: \/not-followed must be <= 100/,
      ) as unknown,
    });
    expect(response.answers[1]).toEqual({ error: expect.stringMatching(/JSON/) as unknown });
    expect(response.answers[2]).toEqual({ error: "grammar evaluation failed" });
    expect(response.answers[3]).toEqual({
      json: { followed: 0, "not-followed": 95, "not-applicable": 5 },
    });
    expect(response.reuse).toBe("checkpoint");
  });

  it("records an item cut off at maxTokens as an error", async () => {
    configureShared("attention");
    const { response } = await shared(RULES, { maxTokens: 20 });
    for (const answer of response.answers) {
      expect(answer).toEqual({
        error: expect.stringMatching(
          /hit the token limit before completing the JSON \(maxTokens: 20\)/,
        ) as unknown,
      });
    }
  });

  it("falls back from a backend that crashes mid-generation, starting over", async () => {
    configureShared("hybrid", {}, { abort: { cuda: "generate" } });
    const { response } = await shared();
    expect(response.answers.every((a) => "json" in a)).toBe(true);
    expect(events("generate").map((e) => e.backend)).toEqual([
      "cuda",
      ...RULES.map(() => "vulkan"),
    ]);
    expect(warnings()).toHaveLength(1);
  });
});

describe("the consumer's process, run for real", () => {
  /** A throwaway parent that imports this repo's sources and makes one call. */
  function parentScript(stay: boolean): string {
    const script = join(dir, "parent.mjs");
    const src = (p: string) => pathToFileURL(resolve(p)).href;
    writeFileSync(
      script,
      `const { setLlamaWorkerBackend, llamaWorkerPids } = await import(${JSON.stringify(src("src/providers/llama-host.ts"))});
const { LlamaCppProvider } = await import(${JSON.stringify(src("src/index.ts"))});
const { join, basename } = await import("node:path");
setLlamaWorkerBackend({
  moduleUrl: ${JSON.stringify(FIXTURE)},
  resolveModelFile: (uri, directory) => Promise.resolve(join(directory, basename(uri))),
});
const provider = new LlamaCppProvider("gemma-4-e4b", { modelsDirectory: ${JSON.stringify(dir)} });
const result = await provider.completeJSON(${JSON.stringify(REQUEST)});
process.stdout.write(JSON.stringify({ json: result.json, worker: llamaWorkerPids()[0] }) + "\\n");
${stay ? "setInterval(() => {}, 1000);" : ""}
`,
    );
    return script;
  }

  const nodeArgs = [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    `--import=${HOOKS}`,
  ];

  it("exits on its own without disposeLlamaModels", async () => {
    const result = await realExec([process.execPath, ...nodeArgs, parentScript(false)], {
      timeoutMs: 60_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    const { json, worker } = JSON.parse(result.stdout.trim()) as {
      json: unknown;
      worker: number;
    };
    expect(json).toMatchObject({ backend: "cuda" });
    await expect.poll(() => isAlive(worker), { timeout: 10_000 }).toBe(false);
  }, 90_000);

  it("takes its worker with it when it is killed", async () => {
    const parent = spawn(process.execPath, [...nodeArgs, parentScript(true)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const line = await new Promise<string>((resolveLine, reject) => {
      let out = "";
      parent.stdout.setEncoding("utf8");
      parent.stdout.on("data", (d: string) => {
        out += d;
        if (out.includes("\n")) resolveLine(out.trim());
      });
      parent.on("exit", (code) => reject(new Error(`parent exited early (${code})`)));
    });
    const { worker } = JSON.parse(line) as { worker: number };
    expect(isAlive(worker)).toBe(true);
    parent.kill("SIGKILL");
    await expect.poll(() => isAlive(worker), { timeout: 15_000 }).toBe(false);
  }, 90_000);
});

describe("the real node-llama-cpp binding, contract only", () => {
  it("reports a model file that is not there as an error, not a crash", async () => {
    setLlamaWorkerBackend(undefined);
    const runtime = defaultLlamaRuntime({ gpu: false });
    const error = await runtime
      .loadModel(join(dir, "missing.gguf"))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/crashed/);
  }, 180_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
