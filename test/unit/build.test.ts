/**
 * What the build must emit for the published package to work.
 *
 * The local-model runtime forks `llama-worker.js` from beside `index.js`. If the
 * build stops emitting it, nothing fails: the runtime warns and runs llama.cpp
 * in-process, and a native crash ends the consumer again. ADR 01012.
 */
import { describe, expect, it } from "vitest";
import config from "../../tsup.config.js";

describe("the build", () => {
  it("emits the local-model worker and the model host as entries beside index.js", () => {
    const options = (Array.isArray(config) ? config[0] : config) as {
      entry?: Record<string, string>;
    };
    expect(options.entry).toMatchObject({
      index: "src/index.ts",
      "llama-worker": "src/providers/llama-worker.ts",
      "llama-hostd": "src/providers/llama-hostd.ts",
    });
  });
});
