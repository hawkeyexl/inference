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
 *   abort          { cuda | vulkan | cpu: "init" | "load" | "prompt" } — where that backend aborts
 *   throwOnPrompt  an ordinary error message every prompt throws
 *   delayMs        how long a prompt takes, so concurrent calls overlap
 *   log            a file each init and prompt is appended to, for the test to read
 */
import { appendFileSync, writeSync } from "node:fs";

const config = JSON.parse(process.env.FAKE_LLAMA ?? "{}");

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
    memoryBudget: async () => 16e9,
    async loadModel(path) {
      if (abortAt === "load") crash(gpu);
      if (path.includes("missing")) throw new Error(`no such model file: ${path}`);
      return {
        trainContextSize: 131_072,
        countTokens: (text) => Math.ceil(text.length / 4),
        async createSession(_systemPrompt, contextSize) {
          return {
            contextSize,
            async prompt() {
              record(`prompt ${label(gpu)} ${process.pid}`);
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
        async dispose() {},
      };
    },
  };
}
