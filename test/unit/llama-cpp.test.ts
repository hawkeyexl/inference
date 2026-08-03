import { beforeEach, describe, expect, it } from "vitest";
import {
  InferenceError,
  LlamaCppProvider,
  LLAMA_MODELS,
  completeValidatedJSON,
  defaultLlamaModelsDirectory,
  disposeLlamaModels,
} from "../../src/index.js";
import type {
  CompleteJSONRequest,
  LlamaPromptOptions,
  LlamaRuntime,
} from "../../src/index.js";

const SCHEMA = {
  type: "object",
  properties: {
    match: { type: "string", enum: ["pass", "fail"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
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

interface Recorded {
  resolvedUris: string[];
  resolvedDirs: string[];
  loadedPaths: string[];
  prompts: { text: string; options: LlamaPromptOptions }[];
  systemPrompts: string[];
}

/** A LlamaRuntime that never touches the network, the filesystem, or a GPU. */
function fakeRuntime(
  responses: (string | Error)[] = ['{"match":"pass","confidence":0.9}'],
): { runtime: LlamaRuntime; recorded: Recorded } {
  const recorded: Recorded = {
    resolvedUris: [],
    resolvedDirs: [],
    loadedPaths: [],
    prompts: [],
    systemPrompts: [],
  };
  let call = 0;
  const runtime: LlamaRuntime = {
    resolveModelFile(uri, directory) {
      recorded.resolvedUris.push(uri);
      recorded.resolvedDirs.push(directory);
      return Promise.resolve(`${directory}/${uri.split("/").pop()}`);
    },
    loadModel(path) {
      recorded.loadedPaths.push(path);
      return Promise.resolve({
        createSession(systemPrompt) {
          recorded.systemPrompts.push(systemPrompt);
          return Promise.resolve({
            prompt(text, options) {
              recorded.prompts.push({ text, options });
              const next = responses[call++ % responses.length]!;
              if (next instanceof Error) return Promise.reject(next);
              return Promise.resolve({
                text: next,
                usage: { inputTokens: 42, outputTokens: 7 },
              });
            },
            dispose() {
              return Promise.resolve();
            },
          });
        },
        dispose() {
          return Promise.resolve();
        },
      });
    },
    getMemoryBudgetBytes() {
      return Promise.resolve(16 * 1e9);
    },
  };
  return { runtime, recorded };
}

beforeEach(async () => {
  await disposeLlamaModels();
});

describe("LlamaCppProvider identity", () => {
  it("reports a stable provider id and the concrete model name", () => {
    const { runtime } = fakeRuntime();
    const provider = new LlamaCppProvider("gemma-4-e4b", { runtime });
    expect(provider.provider()).toBe("llama-cpp");
    expect(provider.modelName()).toBe("gemma-4-e4b");
  });

  it("refuses a selector at construction — those need the async factory", () => {
    const { runtime } = fakeRuntime();
    expect(() => new LlamaCppProvider("auto", { runtime })).toThrow(
      InferenceError,
    );
    expect(() => new LlamaCppProvider("auto", { runtime })).toThrow(
      /makeProviderAsync/,
    );
  });
});

describe("LlamaCppProvider.completeJSON", () => {
  it("resolves the curated alias to its pinned blob URI", async () => {
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST);
    expect(recorded.resolvedUris).toEqual([LLAMA_MODELS["gemma-4-e4b"]!.uri]);
  });

  it("downloads into this library's own directory, not the shared one", async () => {
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST);
    expect(recorded.resolvedDirs[0]).toBe(defaultLlamaModelsDirectory());
    expect(recorded.resolvedDirs[0]).not.toContain(".node-llama-cpp");
  });

  it("honours an explicit modelsDirectory", async () => {
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", {
      runtime,
      modelsDirectory: "/custom/models",
    }).completeJSON(REQUEST);
    expect(recorded.resolvedDirs[0]).toBe("/custom/models");
  });

  it("returns the parsed JSON and usage from the token meter", async () => {
    const { runtime } = fakeRuntime();
    const result = await new LlamaCppProvider("gemma-4-e4b", {
      runtime,
    }).completeJSON(REQUEST);
    expect(result.json).toEqual({ match: "pass", confidence: 0.9 });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it("passes the request schema through as the grammar", async () => {
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST);
    expect(recorded.prompts[0]!.options.schema).toEqual(REQUEST.schema);
  });

  it("restates the schema in the system prompt", async () => {
    // node-llama-cpp never shows the schema to the model under a raw grammar,
    // so field descriptions would be invisible without this.
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST);
    const system = recorded.systemPrompts[0]!;
    expect(system).toContain("You grade claims.");
    expect(system).toContain(JSON.stringify(REQUEST.schema));
  });

  it("passes temperature through", async () => {
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON({
      ...REQUEST,
      temperature: 0.7,
    });
    expect(recorded.prompts[0]!.options.temperature).toBe(0.7);
  });

  it("disables thinking by default so the grammar does not truncate it", async () => {
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST);
    expect(recorded.prompts[0]!.options.thoughtTokens).toBe(0);
  });

  it("honours an explicit thoughtTokens budget", async () => {
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", {
      runtime,
      thoughtTokens: 256,
    }).completeJSON(REQUEST);
    expect(recorded.prompts[0]!.options.thoughtTokens).toBe(256);
  });

  it("tolerates a fenced response", async () => {
    const { runtime } = fakeRuntime([
      '```json\n{"match":"fail","confidence":0.2}\n```',
    ]);
    const result = await new LlamaCppProvider("gemma-4-e4b", {
      runtime,
    }).completeJSON(REQUEST);
    expect(result.json).toEqual({ match: "fail", confidence: 0.2 });
  });
});

describe("model lifecycle", () => {
  it("loads the weights once and reuses them across calls", async () => {
    const { runtime, recorded } = fakeRuntime();
    const provider = new LlamaCppProvider("gemma-4-e4b", { runtime });
    await provider.completeJSON(REQUEST);
    await provider.completeJSON(REQUEST);
    await provider.completeJSON(REQUEST);
    expect(recorded.loadedPaths).toHaveLength(1);
    // A fresh session per call keeps runs independent — no multi-turn state.
    expect(recorded.systemPrompts).toHaveLength(3);
  });

  it("shares one loaded model across separate provider instances", async () => {
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST);
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST);
    expect(recorded.loadedPaths).toHaveLength(1);
  });

  it("treats the same model in two directories as two files", async () => {
    const { runtime, recorded } = fakeRuntime();
    const opts = { runtime };
    await new LlamaCppProvider("gemma-4-e4b", {
      ...opts,
      modelsDirectory: "/a",
    }).completeJSON(REQUEST);
    await new LlamaCppProvider("gemma-4-e4b", {
      ...opts,
      modelsDirectory: "/b",
    }).completeJSON(REQUEST);
    expect(recorded.loadedPaths).toEqual([
      "/a/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf",
      "/b/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf",
    ]);
  });

  it("reloads after disposeLlamaModels", async () => {
    const { runtime, recorded } = fakeRuntime();
    const provider = new LlamaCppProvider("gemma-4-e4b", { runtime });
    await provider.completeJSON(REQUEST);
    await disposeLlamaModels();
    await provider.completeJSON(REQUEST);
    expect(recorded.loadedPaths).toHaveLength(2);
  });

  it("does not cache a failed load", async () => {
    let attempts = 0;
    const runtime: LlamaRuntime = {
      resolveModelFile: (uri) => Promise.resolve(uri),
      loadModel: () => {
        attempts++;
        return Promise.reject(new Error("out of memory"));
      },
      getMemoryBudgetBytes: () => Promise.resolve(0),
    };
    const provider = new LlamaCppProvider("gemma-4-e4b", { runtime });
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /out of memory/,
    );
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /out of memory/,
    );
    expect(attempts).toBe(2);
  });
});

describe("failure handling", () => {
  it("records an errored run rather than throwing out of completeValidatedJSON", async () => {
    const { runtime } = fakeRuntime([new Error("context overflow")]);
    const run = await completeValidatedJSON({
      provider: new LlamaCppProvider("gemma-4-e4b", { runtime }),
      system: REQUEST.system,
      user: REQUEST.user,
      schema: REQUEST.schema,
    });
    expect(run.result).toBeUndefined();
    expect(run.error).toMatch(/context overflow/);
    expect(run.provider).toBe("llama-cpp");
  });

  it("fails validation when the grammar emits an out-of-range number", async () => {
    // GBNF constrains shape, not numeric bounds — confidence 4.2 is well-formed
    // JSON that the schema still rejects. Ajv must catch it.
    const { runtime } = fakeRuntime(['{"match":"pass","confidence":4.2}']);
    const run = await completeValidatedJSON({
      provider: new LlamaCppProvider("gemma-4-e4b", { runtime }),
      system: REQUEST.system,
      user: REQUEST.user,
      schema: REQUEST.schema,
    });
    expect(run.result).toBeUndefined();
    expect(run.error).toMatch(/schema validation/i);
  });

  it("names the token limit when generation is truncated", async () => {
    // Truncated JSON would otherwise surface as a schema-validation failure —
    // or be silently salvaged into a wrong object by extractJson's fallback —
    // and burn a retry that fails identically.
    const runtime: LlamaRuntime = {
      resolveModelFile: (uri) => Promise.resolve(uri),
      loadModel: () =>
        Promise.resolve({
          createSession: () =>
            Promise.resolve({
              prompt: () =>
                Promise.resolve({
                  text: '{"match":"pass","confid',
                  stopReason: "maxTokens",
                  usage: { inputTokens: 10, outputTokens: 8 },
                }),
              dispose: () => Promise.resolve(),
            }),
          dispose: () => Promise.resolve(),
        }),
      getMemoryBudgetBytes: () => Promise.resolve(0),
    };
    const provider = new LlamaCppProvider("gemma-4-e4b", {
      runtime,
      maxTokens: 200,
    });
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /token limit.*maxTokens: 200/s,
    );
  });

  it("does not mistake a normal stop for truncation", async () => {
    const { runtime } = fakeRuntime();
    await expect(
      new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST),
    ).resolves.toBeDefined();
  });

  it("explains how to install node-llama-cpp when it is absent", async () => {
    const provider = new LlamaCppProvider("gemma-4-e4b", {
      runtime: {
        resolveModelFile: () =>
          Promise.reject(
            new InferenceError(
              "The llama-cpp provider needs the optional peer dependency " +
                "node-llama-cpp. Install it with: npm i node-llama-cpp",
            ),
          ),
        loadModel: () => Promise.reject(new Error("unreachable")),
        getMemoryBudgetBytes: () => Promise.resolve(0),
      },
    });
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /npm i node-llama-cpp/,
    );
  });
});
