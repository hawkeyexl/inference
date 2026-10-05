/**
 * Stands in for node-llama-cpp inside the REAL local-model worker.
 *
 * Only the inference is fake — it would otherwise need multi-gigabyte weights
 * and a particular GPU (CLAUDE.md, permitted doubles). Everything around it is
 * real: the worker is a forked Node process, the IPC is Node's, and a "crash"
 * is a genuine `process.abort()`, so the parent sees exactly what it sees when
 * ggml-cuda calls GGML_ABORT: a child that dies mid-request without a reply.
 *
 * Behaviour comes from the FAKE_LLAMA environment variable, which the worker
 * inherits at fork time:
 *
 *   available      GPU backends this "machine" offers, best first (default cuda, vulkan)
 *   abort          { cuda | vulkan | cpu: "init" | "load" | "prompt" | "decide" } — where that backend aborts
 *   throwOnPrompt  an ordinary error message every prompt throws
 *   delayMs        how long a prompt takes, so concurrent calls overlap
 *   log            a file each init, load, prompt and decision probe is appended to, for the test to read
 *   memory         { total, perModel }: the memory budget is total, less perModel per loaded model
 *   decide         { sequence, answers } — how a session's context sequence behaves for decide():
 *                    sequence  "attention" (erasing tokens keeps the rest), "hybrid" (only a
 *                              checkpoint restores a prefix), or "hybrid-without-checkpoints"
 *                              (nothing does, so a prefix is evaluated again)
 *                    answers   { "<text only one question holds>": { "<letter>": probability } }
 */
import { appendFileSync, writeSync } from "node:fs";
import { basename } from "node:path";

const config = JSON.parse(process.env.FAKE_LLAMA ?? "{}");

/** Models loaded and not yet disposed, for the memory budget. */
let loaded = 0;

const label = (gpu) => (gpu === false ? "cpu" : gpu);

function record(line) {
  if (config.log) appendFileSync(config.log, `${line}\n`);
}

/** What ggml prints before GGML_ABORT, then the abort itself. */
function crash(gpu) {
  writeSync(
    2,
    `D:\\a\\node-llama-cpp\\llama\\ggml\\src\\ggml-${label(gpu)}.cu:106: ${label(gpu)} error\n`,
  );
  process.abort();
}

export async function createWorkerBackend(options, hooks) {
  const available = config.available ?? ["cuda", "vulkan"];
  let gpu;
  if (options.gpu === "auto" || typeof options.gpu === "object") {
    const exclude = typeof options.gpu === "object" ? options.gpu.exclude : [];
    gpu = available.find((g) => !exclude.includes(g)) ?? false;
  } else {
    gpu = options.gpu;
    if (gpu !== false && !available.includes(gpu)) {
      throw new Error(`No ${gpu} binary is available on this machine`);
    }
  }
  hooks.trying(gpu);
  record(`init ${label(gpu)} ${process.pid}`);
  const abortAt = config.abort?.[label(gpu)];
  if (abortAt === "init") crash(gpu);

  return {
    gpu,
    memoryBudget: async () =>
      config.memory ? config.memory.total - loaded * config.memory.perModel : 16e9,
    async loadModel(path) {
      if (abortAt === "load") crash(gpu);
      if (path.includes("missing")) throw new Error(`no such model file: ${path}`);
      record(`load ${label(gpu)} ${process.pid} ${basename(path)}`);
      loaded += 1;
      return {
        trainContextSize: 131_072,
        countTokens: (text) => Math.ceil(text.length / 4),
        async createSession(systemPrompt, contextSize) {
          return {
            contextSize,
            sequence: fakeSequence(systemPrompt, gpu, abortAt),
            async prompt(text) {
              record(`prompt ${label(gpu)} ${process.pid} ${encodeURIComponent(text)}`);
              if (config.delayMs) {
                await new Promise((r) => setTimeout(r, config.delayMs));
              }
              if (abortAt === "prompt") crash(gpu);
              if (config.throwOnPrompt) throw new Error(config.throwOnPrompt);
              return {
                text: JSON.stringify({ match: "pass", confidence: 0.9, backend: label(gpu) }),
                stopReason: "eogToken",
                usage: { inputTokens: 42, outputTokens: 7 },
              };
            },
            async dispose() {},
          };
        },
        async dispose() {
          loaded -= 1;
        },
      };
    },
  };
}

/**
 * A context sequence whose tokens are the characters of its text. The decision
 * logic in the worker drives it exactly as it drives node-llama-cpp's: render,
 * evaluate, checkpoint, probe, erase. Only the probabilities are scripted.
 */
function fakeSequence(systemPrompt, gpu, abortAt) {
  const kind = config.decide?.sequence ?? "attention";
  const answers = config.decide?.answers ?? {};
  const encode = (text) => [...text].map((c) => c.codePointAt(0));
  let tokens = [];
  let input = 0;
  let checkpoint;
  const evaluate = (more) => {
    tokens.push(...more);
    input += more.length;
  };
  return {
    get needsCheckpoints() {
      return kind !== "attention";
    },
    get nextTokenIndex() {
      return tokens.length;
    },
    inputTokens: () => input,
    render: (user, answerPrefix) =>
      encode(`<system>${systemPrompt}</system><user>${user}</user><assistant>${answerPrefix}`),
    labelTokens: (label) => encode(label),
    async evaluate(more) {
      evaluate(more);
    },
    async takeCheckpoint() {
      if (kind === "hybrid") checkpoint = tokens.length;
    },
    async erase(start, end) {
      const kept = [...tokens.slice(0, start), ...tokens.slice(end)];
      tokens = [];
      // A checkpoint restores the state as it was at its own length, no other.
      if (kind === "attention" || checkpoint === start) {
        tokens = kept;
        return;
      }
      // No state survives the erase: evaluate what is left from scratch.
      evaluate(kept);
    },
    async probe(more) {
      record(`decide ${label(gpu)} ${process.pid}`);
      if (abortAt === "decide") crash(gpu);
      evaluate(more);
      const text = String.fromCodePoint(...tokens);
      const held = Object.keys(answers).filter((key) => text.includes(key));
      if (held.length > 1) {
        throw new Error(`The fake sequence holds ${held.length} questions at once: ${held.join(", ")}.`);
      }
      const weights = held.length === 1 ? answers[held[0]] : {};
      return new Map(Object.entries(weights).map(([letter, p]) => [letter.codePointAt(0), p]));
    },
  };
}
