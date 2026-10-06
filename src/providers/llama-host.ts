/**
 * The parent side of the local-model worker, and the fallback when a GPU
 * backend crashes it. ADR 01012.
 *
 * `createWorkerRuntime` is a `LlamaRuntime` like any other, so the provider's
 * context sizing, truncation guards and brace repair are unchanged. Behind it,
 * every load, session and prompt is a request to a child process
 * (`llama-worker.ts`) that owns node-llama-cpp. When that child dies with
 * requests in flight — llama.cpp's GGML_ABORT, which no `try` can catch — the
 * requests are retried on the next backend, CUDA → Vulkan → CPU, and the
 * backend that crashed is skipped for the rest of this process.
 *
 * One worker per requested backend, holding its loaded models. A reload per
 * call would move gigabytes of weights; one worker per model would initialise
 * the GPU once per model, and `getLlama` is a per-process singleton anyway.
 */
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InferenceError } from "../types.js";
import {
  importNodeLlamaCpp,
  isModuleNotFound,
  nodeLlamaCppShimUrl,
} from "./llama-install.js";
import { WORKER_ENV_FLAG, completeSharedOn, decideOn, openBackend } from "./llama-worker.js";
import type {
  WorkerBackend,
  WorkerBackendOptions,
  WorkerGpu,
  WorkerMessage,
  WorkerModel,
  WorkerRequest,
} from "./llama-worker.js";
import type {
  LlamaDecideOptions,
  LlamaDecideResult,
  LlamaLoadedModel,
  LlamaPromptOptions,
  LlamaPromptResult,
  LlamaRuntime,
  LlamaSession,
  LlamaSharedOptions,
  LlamaSharedResult,
} from "./llama-cpp.js";

/**
 * Which llama.cpp backend to run on. `"auto"` picks the best one this machine
 * has and falls back from one that crashes; anything else pins it.
 */
export type LlamaGpu = "auto" | WorkerGpu;

const LLAMA_GPUS: readonly LlamaGpu[] = ["auto", "cuda", "vulkan", "metal", false];

export function isLlamaGpu(value: unknown): value is LlamaGpu {
  return LLAMA_GPUS.includes(value as LlamaGpu);
}

/** Lines of the worker's stderr kept to name what killed it. */
const STDERR_TAIL_LINES = 20;
/** How long a worker gets to exit after `shutdown` before it is killed. */
const SHUTDOWN_GRACE_MS = 5_000;
/** How long to wait, after a worker exits, for the rest of its stderr. */
const STDERR_DRAIN_MS = 250;

/** node-llama-cpp's spellings of "no GPU" in `NODE_LLAMA_CPP_GPU`. */
const GPU_OFF_VALUES = ["false", "off", "none", "disable", "disabled"];

/** Where the worker imports the binding from, and how weights are fetched. */
export interface WorkerBackendSource {
  /** A bare specifier or a URL the worker passes to `import()`. */
  moduleUrl: string;
  resolveModelFile(uri: string, directory: string): Promise<string>;
}

/** The worker died with requests in flight. Never escapes this module. */
class LlamaWorkerCrash extends Error {
  constructor(
    readonly host: WorkerHost,
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
    /** The worker was already gone, with nothing of ours in flight: no one to blame. */
    readonly blameless = false,
  ) {
    super("The local-model worker exited.");
    this.name = "LlamaWorkerCrash";
  }
}

/** A request without its id — the host assigns that. */
type Request = WorkerRequest extends infer R
  ? R extends unknown
    ? Omit<R, "id">
    : never
  : never;

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

/** Ref/unref on a piped stdio stream, which Node types as a plain Readable. */
interface Referable {
  ref?(): void;
  unref?(): void;
}

class WorkerHost {
  readonly child: ChildProcess;
  /** The backend that initialised, once it has. */
  gpu: WorkerGpu | undefined;
  /** The backend initialising now, so a crash during `init` is attributable. */
  trying: WorkerGpu | undefined;
  dead = false;
  /** How a crash of this host was handled, decided once for every caller. */
  verdict: Error | "retry" | undefined;
  readonly exited: Promise<void>;
  private closing = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly stderrTail: string[] = [];
  private partialLine = "";

  constructor(entry: string) {
    this.child = fork(entry, [], {
      // stderr is piped rather than inherited so a crash can name its last
      // line; it is still forwarded live, so llama.cpp's output is not lost.
      stdio: ["ignore", "inherit", "pipe", "ipc"],
      serialization: "json",
      // Never the parent's flags (an inspector port, a test runner's loader).
      // From `src/` Node strips the worker's types itself; say nothing about it.
      execArgv: entry.endsWith(".ts")
        ? ["--disable-warning=ExperimentalWarning"]
        : [],
      env: { ...process.env, [WORKER_ENV_FLAG]: "1" },
    });
    const stderr = this.child.stderr!;
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      process.stderr.write(chunk);
      this.collect(chunk);
    });
    this.child.on("message", (message: WorkerMessage) => this.onMessage(message));
    this.exited = new Promise<void>((resolve) => {
      this.child.once("error", (e) => {
        this.dead = true;
        this.rejectAll(
          new InferenceError(`Could not start the local-model worker (${e.message}).`),
        );
        resolve();
      });
      this.child.once("exit", (code, signal) => {
        this.dead = true;
        void this.drainStderr().then(() => {
          this.onExit(code, signal);
          resolve();
        });
      });
    });
    this.idle();
  }

  get pid(): number | undefined {
    return this.dead ? undefined : this.child.pid;
  }

  get stderr(): readonly string[] {
    return this.partialLine
      ? [...this.stderrTail, this.partialLine]
      : this.stderrTail;
  }

  request<T>(request: Request): Promise<T> {
    if (this.dead) {
      return Promise.reject(new LlamaWorkerCrash(this, null, null, true));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      if (this.pending.size === 1) this.busy();
      this.child.send({ ...request, id }, (e) => {
        // A channel that closed under us; the exit handler names the cause
        // if the worker died, so only a still-pending request is settled here.
        if (e && this.pending.delete(id)) {
          if (this.pending.size === 0) this.idle();
          reject(new LlamaWorkerCrash(this, null, null, true));
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.dead) return;
    this.closing = true;
    this.busy();
    try {
      this.child.send({ id: this.nextId++, op: "shutdown" });
    } catch {
      // Already disconnected; the kill below covers it.
    }
    const timer = setTimeout(() => this.child.kill(), SHUTDOWN_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }

  private onMessage(message: WorkerMessage): void {
    if ("event" in message) {
      this.trying = message.gpu;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (this.pending.size === 0) this.idle();
    if (message.ok) {
      pending.resolve(message.value);
    } else {
      pending.reject(rebuildError(message.error));
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.pending.size === 0) return;
    this.rejectAll(
      this.closing
        ? new InferenceError(
            "The local-model worker was shut down by disposeLlamaModels while a call was still running.",
          )
        : new LlamaWorkerCrash(this, code, signal),
    );
  }

  private rejectAll(reason: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.idle();
    for (const p of pending) p.reject(reason);
  }

  private collect(chunk: string): void {
    const lines = (this.partialLine + chunk).split(/\r?\n/);
    this.partialLine = lines.pop() ?? "";
    this.stderrTail.push(...lines);
    this.stderrTail.splice(0, Math.max(0, this.stderrTail.length - STDERR_TAIL_LINES));
  }

  /** `exit` can arrive before the last of stderr; give it a moment. */
  private drainStderr(): Promise<void> {
    const stderr = this.child.stderr!;
    if (stderr.readableEnded || stderr.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STDERR_DRAIN_MS);
      timer.unref();
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      stderr.once("end", done);
      stderr.once("close", done);
    });
  }

  /**
   * Hold the parent open only while it is waiting on the worker. An idle
   * worker must not keep a consumer's process alive after its work is done —
   * and when that process exits, the worker sees `disconnect` and exits too.
   */
  private busy(): void {
    this.child.ref();
    this.child.channel?.ref();
    (this.child.stderr as Referable | null)?.ref?.();
  }

  private idle(): void {
    this.child.unref();
    this.child.channel?.unref();
    (this.child.stderr as Referable | null)?.unref?.();
  }
}

function rebuildError(error: { name: string; message: string }): Error {
  if (error.name === "InferenceError") return new InferenceError(error.message);
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

function backendName(gpu: WorkerGpu): string {
  switch (gpu) {
    case "cuda":
      return "CUDA";
    case "vulkan":
      return "Vulkan";
    case "metal":
      return "Metal";
    default:
      return "CPU";
  }
}

/**
 * GGML_ABORT's own line: `<source file>:<line>: <message>`. A backtrace often
 * follows it, and its frames say "abort" too, so this is looked for first.
 */
const GGML_ABORT_LINE = /\.(?:cu|cpp|cc|c|h|m|mm):\d+: \S/;

/** "exit code 127: …ggml-cuda.cu:106: CUDA error" — how it died, and its last word. */
function describeExit(crash: LlamaWorkerCrash): string {
  const how = crash.signal ? `signal ${crash.signal}` : `exit code ${String(crash.code)}`;
  const lines = crash.host.stderr.map((l) => l.trim()).filter((l) => l !== "");
  const line =
    [...lines].reverse().find((l) => GGML_ABORT_LINE.test(l)) ??
    lines.find((l) => /error|abort|assert|fatal/i.test(l)) ??
    lines[lines.length - 1];
  return line ? `${how}: ${line}` : how;
}

/** GPU backends that crashed a worker, with how; skipped for the rest of the process. */
const failedBackends = new Map<WorkerGpu, string>();

/**
 * One worker slot per requested backend. `"auto"` moves down the fallback
 * chain as backends crash; a pinned backend never moves.
 */
class Slot {
  private host: WorkerHost | undefined;
  private starting: Promise<WorkerHost> | undefined;
  /** The crash a new worker is replacing, so its start can say what changed. */
  private switchedFrom: { gpu: WorkerGpu; exit: string } | undefined;

  constructor(
    readonly gpu: LlamaGpu,
    /** Where a pinned backend was chosen, for the error that names it. */
    readonly source: string | undefined,
    private readonly entry: string,
  ) {}

  get pid(): number | undefined {
    return this.host?.pid;
  }

  /**
   * Run `fn` against a live worker, retrying on the next backend when the
   * worker crashes under it. Ordinary errors pass through untouched.
   */
  async run<T>(fn: (host: WorkerHost) => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await fn(await this.acquire());
      } catch (e) {
        if (!(e instanceof LlamaWorkerCrash)) throw e;
        // Concurrent calls all see the same crash; the first decides for all,
        // so there is one warning and one replacement worker.
        const verdict = (e.host.verdict ??= this.decide(e));
        if (verdict instanceof Error) throw verdict;
      }
    }
  }

  async shutdown(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    this.starting = undefined;
    await host?.shutdown();
  }

  private acquire(): Promise<WorkerHost> {
    if (this.starting && !this.host?.dead) return this.starting;
    const starting = (async (): Promise<WorkerHost> => {
      const source = await backendSource();
      const host = new WorkerHost(this.entry);
      this.host = host;
      const { gpu } = await host.request<{ gpu: WorkerGpu }>({
        op: "init",
        moduleUrl: source.moduleUrl,
        options: this.options(),
      });
      host.gpu = gpu;
      if (this.switchedFrom) {
        warnSwitch(this.switchedFrom, gpu);
        this.switchedFrom = undefined;
      }
      return host;
    })();
    this.starting = starting;
    // An ordinary failure to start (no binary, no binding) must not poison the
    // slot: drop it so the next call tries again, the same rule `load()`
    // applies to weights. A crash is `run`'s to handle.
    starting.catch((e: unknown) => {
      if (e instanceof LlamaWorkerCrash || this.starting !== starting) return;
      const host = this.host;
      this.starting = undefined;
      this.host = undefined;
      void host?.shutdown();
    });
    return starting;
  }

  private options(): WorkerBackendOptions {
    if (this.gpu !== "auto") return { gpu: this.gpu };
    const exclude = [...failedBackends.keys()];
    return exclude.length > 0
      ? { gpu: { type: "auto", exclude }, build: "never" }
      : { gpu: "auto" };
  }

  private decide(crash: LlamaWorkerCrash): Error | "retry" {
    if (this.host === crash.host) {
      this.host = undefined;
      this.starting = undefined;
    }
    if (crash.blameless) return "retry";

    const gpu = crash.host.gpu ?? crash.host.trying;
    const exit = describeExit(crash);
    if (gpu === undefined) {
      return new InferenceError(
        `llama.cpp's local-model worker crashed before it chose a backend ` +
          `(${exit}). The request was not answered.`,
      );
    }
    const name = backendName(gpu);
    if (this.gpu !== "auto") {
      return new InferenceError(
        `llama.cpp's ${name} backend crashed the local-model worker (${exit}). ` +
          `${name} was chosen explicitly (${this.source ?? "llamaCpp.gpu"}), so ` +
          `the library did not switch backends. Choose another — ` +
          `${alternativesTo(gpu)} — or unset it to let the library fall back on its own.`,
      );
    }
    if (gpu === false) {
      // Not recorded: a crash on the last resort says more about the request
      // than the backend, and refusing every later call would be worse.
      const all = [...failedBackends].map(([g, e]) => `${backendName(g)} (${e})`);
      return new InferenceError(
        `llama.cpp crashed the local-model worker on every backend this machine ` +
          `offers — ${[...all, `CPU (${exit})`].join(", ")}. The request was not answered.`,
      );
    }
    failedBackends.set(gpu, exit);
    this.switchedFrom = { gpu, exit };
    return "retry";
  }
}

function alternativesTo(gpu: WorkerGpu): string {
  switch (gpu) {
    case "cuda":
      return "NODE_LLAMA_CPP_GPU=vulkan, or false for the CPU";
    case "vulkan":
      return "NODE_LLAMA_CPP_GPU=cuda, or false for the CPU";
    case "metal":
      return "NODE_LLAMA_CPP_GPU=false for the CPU";
    default:
      return "NODE_LLAMA_CPP_GPU=auto for a GPU backend";
  }
}

function warnSwitch(from: { gpu: WorkerGpu; exit: string }, to: WorkerGpu): void {
  const crashed = `inference: llama.cpp's ${backendName(from.gpu)} backend crashed the local-model worker (${from.exit}).`;
  if (to === false) {
    console.warn(
      `${crashed} Retrying on the CPU, which is much slower — expect minutes per ` +
        `call — and staying there for the rest of this process. Pin a backend ` +
        `with NODE_LLAMA_CPP_GPU or llamaCpp.gpu to fail fast instead.`,
    );
    return;
  }
  const name = backendName(to);
  console.warn(
    `${crashed} Retrying on ${name}, and staying on ${name} for the rest of this ` +
      `process. Set NODE_LLAMA_CPP_GPU=${to} (or llamaCpp.gpu: "${to}") to start there.`,
  );
}

/**
 * The backend this runtime asks for, and where the choice came from. Unset,
 * `NODE_LLAMA_CPP_GPU` decides, read the way node-llama-cpp reads it — so a
 * pinned environment is honoured, and never silently overridden.
 */
function requestedGpu(
  option: LlamaGpu | undefined,
  env: Record<string, string | undefined> = process.env,
): { gpu: LlamaGpu; source?: string } {
  if (option !== undefined) {
    return option === "auto"
      ? { gpu: "auto" }
      : { gpu: option, source: `llamaCpp.gpu: ${JSON.stringify(option)}` };
  }
  const raw = env["NODE_LLAMA_CPP_GPU"];
  if (raw == null || raw === "" || raw === "auto") return { gpu: "auto" };
  if (GPU_OFF_VALUES.includes(raw)) {
    return { gpu: false, source: `NODE_LLAMA_CPP_GPU=${raw}` };
  }
  if (raw === "cuda" || raw === "vulkan" || raw === "metal") {
    return { gpu: raw, source: `NODE_LLAMA_CPP_GPU=${raw}` };
  }
  // node-llama-cpp treats an unrecognised value as auto; so does this.
  return { gpu: "auto" };
}

const slots = new Map<string, Slot>();

function slotFor(gpu: LlamaGpu, source: string | undefined, entry: string): Slot {
  const key = JSON.stringify([gpu, source ?? null]);
  let slot = slots.get(key);
  if (!slot) {
    slot = new Slot(gpu, source, entry);
    slots.set(key, slot);
  }
  return slot;
}

let sourceOverride: WorkerBackendSource | undefined;
let defaultSource: Promise<WorkerBackendSource> | undefined;

function backendSource(): Promise<WorkerBackendSource> {
  if (sourceOverride) return Promise.resolve(sourceOverride);
  // Drop a failed resolution so the next call retries — a binary still being
  // extracted by a concurrent install must not poison the process.
  return (defaultSource ??= nodeLlamaCppSource().catch((e: unknown) => {
    defaultSource = undefined;
    throw e;
  }));
}

/**
 * Find node-llama-cpp the way this library always has — the consumer's own
 * copy, else the auto-installed prefix — and tell the worker where it is.
 * Importing it here loads no native code; only `getLlama` does, in the worker.
 */
async function nodeLlamaCppSource(): Promise<WorkerBackendSource> {
  let mod: typeof import("node-llama-cpp");
  let moduleUrl = "node-llama-cpp";
  try {
    mod = await import("node-llama-cpp");
  } catch (e) {
    // A package that resolved and then failed to load — ABI mismatch, missing
    // system library, unsupported Node — is not a missing package. Installing
    // over it would fetch the same broken thing again and replace a precise
    // error with a download.
    if (!isModuleNotFound(e)) {
      throw new InferenceError(
        `node-llama-cpp is installed but failed to load (${
          e instanceof Error ? e.message : String(e)
        }). This is the copy resolved from your own node_modules, so ` +
          `reinstalling it here will not help — check the Node version and the ` +
          `platform build.`,
      );
    }
    // Genuinely absent, so fall back to the library's own prefix — installing
    // it there if needed. npm does not install optional peers, and detection
    // ends at this provider precisely because it needs no credentials, so
    // refusing here would strand the one machine `auto` exists to serve.
    mod = (await importNodeLlamaCpp()) as typeof import("node-llama-cpp");
    moduleUrl = nodeLlamaCppShimUrl();
  }
  return {
    moduleUrl,
    // `directory` is this library's own, not node-llama-cpp's global default —
    // owning it is what makes `clearLlamaModels` safe.
    resolveModelFile: (uri, directory) => mod.resolveModelFile(uri, { directory }),
  };
}

/**
 * The worker beside this module: `llama-worker.js` once built into `dist/`,
 * `llama-worker.ts` when running from source. Absent only when a consumer has
 * bundled this library into a file of its own.
 */
function workerEntry(): string | undefined {
  for (const name of ["llama-worker.js", "llama-worker.ts"]) {
    const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * A loaded model whose weights live in a worker — reloaded in the next one
 * when a fallback replaces it. Handed out through `plainModel`.
 */
class WorkerModelProxy {
  trainContextSize?: number;
  private readonly ids = new Map<
    WorkerHost,
    Promise<{ modelId: number; trainContextSize?: number }>
  >();

  constructor(
    private readonly slot: Slot,
    private readonly path: string,
  ) {}

  async open(): Promise<void> {
    const loaded = await this.slot.run((host) => this.on(host));
    this.trainContextSize = loaded.trainContextSize;
  }

  /** This model's id in `host`, loading it there first if a fallback moved us. */
  on(host: WorkerHost): Promise<{ modelId: number; trainContextSize?: number }> {
    for (const known of this.ids.keys()) if (known.dead) this.ids.delete(known);
    let loaded = this.ids.get(host);
    if (!loaded) {
      loaded = host.request({ op: "loadModel", path: this.path });
      this.ids.set(host, loaded);
      const settled = loaded;
      settled.catch(() => {
        if (this.ids.get(host) === settled) this.ids.delete(host);
      });
    }
    return loaded;
  }

  countTokens(text: string): Promise<number> {
    return this.slot.run(async (host) =>
      host.request<number>({
        op: "countTokens",
        modelId: (await this.on(host)).modelId,
        text,
      }),
    );
  }

  async createSession(systemPrompt: string, contextSize?: number): Promise<LlamaSession> {
    const session = new WorkerSessionProxy(this.slot, this, systemPrompt, contextSize);
    await session.open();
    return {
      contextSize: session.contextSize,
      prompt: (text, options) => session.prompt(text, options),
      decide: (options) => session.decide(options),
      completeShared: (options) => session.completeShared(options),
      dispose: () => session.dispose(),
    };
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.ids].map(async ([host, loaded]) => {
        if (host.dead) return;
        const { modelId } = await loaded;
        await host.request({ op: "disposeModel", modelId });
      }).map((p) => p.catch(() => undefined)),
    );
    this.ids.clear();
  }
}

class WorkerSessionProxy {
  contextSize?: number;
  private readonly ids = new Map<WorkerHost, Promise<number>>();

  constructor(
    private readonly slot: Slot,
    private readonly model: WorkerModelProxy,
    private readonly systemPrompt: string,
    private readonly requestedSize: number | undefined,
  ) {}

  async open(): Promise<void> {
    await this.slot.run((host) => this.on(host));
  }

  /** This session's id in `host`. A retried prompt gets a fresh one there. */
  private on(host: WorkerHost): Promise<number> {
    let id = this.ids.get(host);
    if (!id) {
      id = (async () => {
        const opened = await host.request<{ sessionId: number; contextSize?: number }>({
          op: "createSession",
          modelId: (await this.model.on(host)).modelId,
          systemPrompt: this.systemPrompt,
          ...(this.requestedSize != null ? { contextSize: this.requestedSize } : {}),
        });
        this.contextSize = opened.contextSize;
        return opened.sessionId;
      })();
      this.ids.set(host, id);
      const settled = id;
      settled.catch(() => {
        if (this.ids.get(host) === settled) this.ids.delete(host);
      });
    }
    return id;
  }

  prompt(text: string, options: LlamaPromptOptions): Promise<LlamaPromptResult> {
    return this.slot.run(async (host) =>
      host.request<LlamaPromptResult>({
        op: "prompt",
        sessionId: await this.on(host),
        text,
        options,
      }),
    );
  }

  /** A retried decision starts over on a fresh session, like a retried prompt. */
  decide(options: LlamaDecideOptions): Promise<LlamaDecideResult> {
    return this.slot.run(async (host) =>
      host.request<LlamaDecideResult>({
        op: "decide",
        sessionId: await this.on(host),
        options,
      }),
    );
  }

  /** Like a decision: a retry starts over, every item, on a fresh session. */
  completeShared(options: LlamaSharedOptions): Promise<LlamaSharedResult> {
    return this.slot.run(async (host) =>
      host.request<LlamaSharedResult>({
        op: "completeShared",
        sessionId: await this.on(host),
        options,
      }),
    );
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.ids].map(async ([host, id]) => {
        if (host.dead) return;
        await host.request({ op: "disposeSession", sessionId: await id });
      }).map((p) => p.catch(() => undefined)),
    );
    this.ids.clear();
  }
}

let warnedInProcess = false;

/**
 * No worker beside this module, so no isolation: run in-process as before
 * this change rather than refuse, and say what that costs.
 */
function inProcessRuntime(gpu: LlamaGpu): LlamaRuntime {
  if (!warnedInProcess) {
    warnedInProcess = true;
    console.warn(
      `inference: the local-model worker (llama-worker.js) is missing beside this ` +
        `library — was it bundled? Running llama.cpp in-process instead, so a ` +
        `native crash in llama.cpp will end this process.`,
    );
  }
  let opened: Promise<WorkerBackend> | undefined;
  const backend = (): Promise<WorkerBackend> =>
    (opened ??= backendSource()
      .then(async (source) =>
        openBackend(await import(source.moduleUrl), { gpu }, { trying: () => undefined }),
      )
      .catch((e: unknown) => {
        opened = undefined;
        throw e;
      }));
  return {
    resolveModelFile: (uri, directory) =>
      backendSource().then((source) => source.resolveModelFile(uri, directory)),
    loadModel: (path) => backend().then(async (b) => deciding(await b.loadModel(path))),
    getMemoryBudgetBytes: () => backend().then((b) => b.memoryBudget()),
  };
}

/** An in-process model whose sessions decide and complete here, as the worker's would there. */
function deciding(model: WorkerModel): LlamaLoadedModel {
  return {
    trainContextSize: model.trainContextSize,
    countTokens: (text) => model.countTokens(text),
    dispose: () => model.dispose(),
    async createSession(systemPrompt, contextSize) {
      const session = await model.createSession(systemPrompt, contextSize);
      return {
        contextSize: session.contextSize,
        prompt: (text, options) => session.prompt(text, options),
        decide: (options) => decideOn(session, options),
        completeShared: (options) => completeSharedOn(session, options),
        dispose: () => session.dispose(),
      };
    },
  };
}

/**
 * The real local-model runtime: node-llama-cpp in a worker process, falling
 * back from a backend that crashes it unless `gpu` (or `NODE_LLAMA_CPP_GPU`)
 * pins one.
 */
export function createWorkerRuntime(options: { gpu?: LlamaGpu } = {}): LlamaRuntime {
  const { gpu, source } = requestedGpu(options.gpu);
  const entry = workerEntry();
  if (!entry) return inProcessRuntime(gpu);
  const slot = slotFor(gpu, source, entry);
  return {
    resolveModelFile: (uri, directory) =>
      backendSource().then((s) => s.resolveModelFile(uri, directory)),
    async loadModel(path) {
      const model = new WorkerModelProxy(slot, path);
      await model.open();
      // Object literals, as the in-process runtime returned: a wrapper that
      // spreads a model or session must not lose a class's methods.
      return {
        trainContextSize: model.trainContextSize,
        countTokens: (text) => model.countTokens(text),
        createSession: (systemPrompt, contextSize) =>
          model.createSession(systemPrompt, contextSize),
        dispose: () => model.dispose(),
      } satisfies LlamaLoadedModel;
    },
    getMemoryBudgetBytes: () =>
      slot.run((host) => host.request<number>({ op: "memoryBudget" })),
  };
}

/** Stop every worker. Failed backends stay failed: that is per process. */
export async function shutdownLlamaWorkers(): Promise<void> {
  await Promise.all([...slots.values()].map((slot) => slot.shutdown()));
}

/** Test seam: run workers against a stand-in for node-llama-cpp. */
export function setLlamaWorkerBackend(source: WorkerBackendSource | undefined): void {
  sourceOverride = source;
}

/** Test seam: stop every worker and forget every failed backend. */
export async function resetLlamaWorkers(): Promise<void> {
  await shutdownLlamaWorkers();
  failedBackends.clear();
  warnedInProcess = false;
}

/** Test seam: the pids of the workers running now. */
export function llamaWorkerPids(): number[] {
  return [...slots.values()].flatMap((slot) => (slot.pid != null ? [slot.pid] : []));
}
