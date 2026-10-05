/**
 * The REAL model host, run from source, with its worker loading the fake
 * llama backend in place of node-llama-cpp.
 *
 * Only the inference is fake (CLAUDE.md, permitted doubles). The host is a
 * detached process the client spawns, its sockets are real, and its worker is
 * the real `llama-worker.ts`. Run with `--import ts-hooks.mjs` and
 * `--experimental-transform-types`, as `model-host.test.ts` does.
 */
import { basename, join } from "node:path";

const { setLlamaWorkerBackend } = await import("../../src/providers/llama-host.js");
setLlamaWorkerBackend({
  moduleUrl: new URL("./fake-llama-backend.mjs", import.meta.url).href,
  resolveModelFile: async (uri, directory) => join(directory, basename(uri)),
});
await import("../../src/providers/llama-hostd.js");
