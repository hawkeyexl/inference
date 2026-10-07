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
 *   abort          { cuda | vulkan | cpu: "init" | "load" | "prompt" | "decide" | "generate" } — where that backend aborts
 *   throwOnPrompt  an ordinary error message every prompt throws
 *   delayMs        how long a prompt takes, so concurrent calls overlap
 *   log            a file each init, load, prompt and decision probe is appended to, for the test to read
 *   memory         { total, perModel }: the memory budget is total, less perModel per loaded model
 *   decide         { sequence, answers } — how a session's context sequence behaves for decide():
 *                    sequence  "attention" (erasing tokens keeps the rest), "hybrid" (only a
 *                              checkpoint restores a prefix), or "hybrid-without-checkpoints"
 *                              (nothing does, so a prefix is evaluated again)
 *                    answers   { "<text only one question holds>": { "<letter>": probability } }
 *   sequence       the same choice of sequence for completeJSONShared (default: decide's, else "attention")
 *   shared         { outputs } — what completeJSONShared generates for each item:
 *                    outputs   { "<text only one item holds>": "<generated text>" | { throw: "<message>" } }
 *
 * The log also records "prefix" each time the shared tokens are evaluated: once
 * up front, and again whenever an erase could not keep them; "context" with its
 * size each time a context is created; and "count" with the number of texts
 * each time the tokenizer is asked.
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
        countTokens(texts) {
          record(`count ${label(gpu)} ${process.pid} ${texts.length}`);
          return texts.map((text) => Math.ceil(text.length / 4));
        },
        async createContext(contextSize) {
          record(`context ${label(gpu)} ${process.pid} ${contextSize}`);
          // What the context holds outlives a session, as a real context's does.
          const state = { tokens: [], input: 0, checkpoint: undefined };
          return {
            contextSize,
            async clear() {
              state.tokens = [];
              state.checkpoint = undefined;
            },
            session: (systemPrompt) => fakeSession(state, contextSize, systemPrompt, gpu, abortAt),
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

/** One call's session over a context: its chat, and the context's sequence. */
function fakeSession(state, contextSize, systemPrompt, gpu, abortAt) {
  return {
    contextSize,
    sequence: fakeSequence(state, systemPrompt, gpu, abortAt),
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
}

/**
 * A context sequence whose tokens are the characters of its text. The decision
 * logic in the worker drives it exactly as it drives node-llama-cpp's: render,
 * evaluate, checkpoint, probe, erase. Only the probabilities are scripted.
 */
function fakeSequence(state, systemPrompt, gpu, abortAt) {
  const kind = config.sequence ?? config.decide?.sequence ?? "attention";
  const outputs = config.shared?.outputs ?? {};
  const answers = config.decide?.answers ?? {};
  const encode = (text) => [...text].map((c) => c.codePointAt(0));
  const evaluate = (more) => {
    state.tokens.push(...more);
    state.input += more.length;
  };
  /** The scripted keys the context holds now; more than one is a reuse bug. */
  const holding = (scripted) => {
    const text = String.fromCodePoint(...state.tokens);
    const held = Object.keys(scripted).filter((key) => text.includes(key));
    if (held.length > 1) {
      throw new Error(`The fake sequence holds ${held.length} questions at once: ${held.join(", ")}.`);
    }
    return held[0];
  };
  return {
    get needsCheckpoints() {
      return kind !== "attention";
    },
    get nextTokenIndex() {
      return state.tokens.length;
    },
    inputTokens: () => state.input,
    render: (user, answerPrefix) =>
      encode(`<system>${systemPrompt}</system><user>${user}</user><assistant>${answerPrefix}`),
    labelTokens: (label) => encode(label),
    detokenize: (some) => String.fromCodePoint(...some),
    async evaluate(more) {
      record(`prefix ${label(gpu)} ${process.pid}`);
      evaluate(more);
    },
    async takeCheckpoint() {
      if (kind === "hybrid") state.checkpoint = state.tokens.length;
    },
    async erase(start, end) {
      const kept = [...state.tokens.slice(0, start), ...state.tokens.slice(end)];
      state.tokens = [];
      // A checkpoint restores the state as it was at its own length, no other.
      if (kind === "attention" || state.checkpoint === start) {
        state.tokens = kept;
        return;
      }
      // No state survives the erase: evaluate what is left from scratch.
      record(`prefix ${label(gpu)} ${process.pid}`);
      evaluate(kept);
    },
    /** With `topK`, only that many of the most likely tokens, as llama.cpp's sampler returns. */
    async probe(more, topK) {
      record(`decide ${label(gpu)} ${process.pid} ${topK ?? "all"}`);
      if (abortAt === "decide") crash(gpu);
      evaluate(more);
      const held = holding(answers);
      const weights = Object.entries(held === undefined ? {} : answers[held])
        .sort(([, a], [, b]) => b - a)
        .slice(0, topK ?? Infinity);
      return new Map(weights.map(([letter, p]) => [letter.codePointAt(0), p]));
    },
    /** Evaluate `more`, then yield the scripted text one character at a time; the end is EOG. */
    async *generate(more) {
      record(`generate ${label(gpu)} ${process.pid}`);
      if (abortAt === "generate") crash(gpu);
      evaluate(more);
      const held = holding(outputs);
      const output = held === undefined ? "{}" : outputs[held];
      if (typeof output === "object") throw new Error(output.throw);
      for (const token of encode(output)) {
        // A yielded token is in the context from here on, as node-llama-cpp's are.
        state.tokens.push(token);
        yield token;
      }
    },
  };
}
