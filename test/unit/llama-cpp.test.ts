/**
 * The llama-cpp provider.
 *
 * The injected `LlamaRuntime` here is one of the three permitted doubles: every
 * method on it sits downstream of a multi-gigabyte Hugging Face download, which
 * is a third-party network integration (CLAUDE.md, real-machine verification).
 * Real weights ARE exercised — in `test/integration/live-llama.test.ts`, gated
 * on `INFERENCE_LIVE_LLAMA` and run by hand before opening a PR.
 *
 * Everything that does not need weights runs for real here: the constructor's
 * selector rejection, model-reference resolution, and the directory the
 * provider actually reads.
 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  InferenceError,
  LlamaCppProvider,
  LLAMA_MODELS,
  completeValidatedJSON,
  defaultLlamaModelsDirectory,
  disposeLlamaModels,
  isModelDownloaded,
  makeProviderAsync,
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
  contextSizes: number[];
}

/**
 * The fake tokenizer: one token per four characters, rounded up. Real counts
 * come from the model's own tokenizer; the sizing tests only need a count the
 * test can reproduce.
 */
const fakeTokens = (text: string): number => Math.ceil(text.length / 4);

/** A LlamaRuntime that never touches the network, the filesystem, or a GPU. */
function fakeRuntime(
  responses: (string | Error)[] = ['{"match":"pass","confidence":0.9}'],
  { trainContextSize = 131_072 }: { trainContextSize?: number } = {},
): { runtime: LlamaRuntime; recorded: Recorded } {
  const recorded: Recorded = {
    resolvedUris: [],
    resolvedDirs: [],
    loadedPaths: [],
    prompts: [],
    systemPrompts: [],
    contextSizes: [],
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
        trainContextSize,
        countTokens: fakeTokens,
        createSession(systemPrompt, contextSize) {
          recorded.systemPrompts.push(systemPrompt);
          if (contextSize != null) recorded.contextSizes.push(contextSize);
          return Promise.resolve({
            contextSize,
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

describe("context sizing", () => {
  // node-llama-cpp's default context is the largest that free memory allows,
  // up to the model's training context. For granite-4.1-3b-q2 on CPU that was
  // all 131072 tokens — about 11 GB for a prompt of a few thousand — which
  // OOM-killed 16 GB CI runners. ADR 01011.

  /** What the provider reserves for a call, with the fake tokenizer. */
  function needed(
    req: CompleteJSONRequest,
    systemPrompt: string,
    { maxTokens, thoughtTokens = 0 }: { maxTokens?: number; thoughtTokens?: number } = {},
  ): number {
    return (
      fakeTokens(systemPrompt) +
      fakeTokens(req.user) +
      512 +
      (maxTokens ?? 2048) +
      thoughtTokens
    );
  }

  it("creates an 8192-token context for a prompt that fits, whatever memory is free", async () => {
    const { runtime, recorded } = fakeRuntime();
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST);
    expect(recorded.contextSizes).toEqual([8192]);
  });

  it("never asks for more than the model was trained on", async () => {
    const { runtime, recorded } = fakeRuntime(undefined, {
      trainContextSize: 4096,
    });
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(REQUEST);
    expect(recorded.contextSizes).toEqual([4096]);
  });

  it("sizes the context up to fit a prompt the default cannot hold", async () => {
    const { runtime, recorded } = fakeRuntime();
    const req = { ...REQUEST, user: "x".repeat(4 * 20_000) };
    await new LlamaCppProvider("gemma-4-e4b", { runtime }).completeJSON(req);
    const size = recorded.contextSizes[0]!;
    expect(size).toBe(needed(req, recorded.systemPrompts[0]!));
    expect(size).toBeGreaterThan(8192);
    expect(size).toBeLessThan(131_072);
  });

  it("reserves maxTokens and the thinking budget for the response", async () => {
    const { runtime, recorded } = fakeRuntime();
    const req = { ...REQUEST, user: "x".repeat(4 * 20_000) };
    await new LlamaCppProvider("gemma-4-e4b", {
      runtime,
      maxTokens: 6000,
      thoughtTokens: 1000,
    }).completeJSON(req);
    expect(recorded.contextSizes[0]).toBe(
      needed(req, recorded.systemPrompts[0]!, {
        maxTokens: 6000,
        thoughtTokens: 1000,
      }),
    );
  });

  it("fails with an InferenceError, before generating, when the training context is too small", async () => {
    const { runtime, recorded } = fakeRuntime(undefined, {
      trainContextSize: 8192,
    });
    const req = { ...REQUEST, user: "x".repeat(4 * 20_000) };
    const provider = new LlamaCppProvider("gemma-4-e4b", { runtime });
    const error: unknown = await provider.completeJSON(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toMatch(
      /needs \d+ tokens of context, more than this model's training context of 8192 tokens/,
    );
    // Nothing was created, so nothing was silently truncated.
    expect(recorded.contextSizes).toEqual([]);
    expect(recorded.prompts).toEqual([]);
  });

  it("records the oversized prompt as an errored run, never a result", async () => {
    const { runtime } = fakeRuntime(undefined, { trainContextSize: 8192 });
    const run = await completeValidatedJSON({
      provider: new LlamaCppProvider("gemma-4-e4b", { runtime }),
      system: REQUEST.system,
      user: "x".repeat(4 * 20_000),
      schema: REQUEST.schema,
    });
    expect(run.result).toBeUndefined();
    expect(run.error).toMatch(/training context of 8192 tokens/);
  });

  it.each([4096, 32_768])(
    "uses an explicit contextSize of %i as given, whatever the default",
    async (contextSize) => {
      const { runtime, recorded } = fakeRuntime();
      await new LlamaCppProvider("gemma-4-e4b", {
        runtime,
        contextSize,
      }).completeJSON(REQUEST);
      expect(recorded.contextSizes).toEqual([contextSize]);
    },
  );

  it("fits a small explicit contextSize when maxTokens bounds the response", async () => {
    // Unbounded, the response is reserved 2048 tokens, so a 2048-token context
    // can never hold a prompt as well. maxTokens is what makes it fit.
    const { runtime, recorded } = fakeRuntime();
    const provider = new LlamaCppProvider("gemma-4-e4b", {
      runtime,
      contextSize: 2048,
    });
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /set llamaCpp\.maxTokens/,
    );
    await disposeLlamaModels();
    await new LlamaCppProvider("gemma-4-e4b", {
      runtime,
      contextSize: 2048,
      maxTokens: 512,
    }).completeJSON(REQUEST);
    expect(recorded.contextSizes).toEqual([2048]);
  });

  it("fails with an InferenceError when the prompt does not fit an explicit contextSize", async () => {
    const { runtime, recorded } = fakeRuntime();
    const req = { ...REQUEST, user: "x".repeat(4 * 20_000) };
    const provider = new LlamaCppProvider("gemma-4-e4b", {
      runtime,
      contextSize: 8192,
    });
    const error: unknown = await provider.completeJSON(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toMatch(
      /needs \d+ tokens of context, more than llamaCpp\.contextSize \(8192\)/,
    );
    expect(recorded.contextSizes).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects contextSize %s at construction",
    (contextSize) => {
      const { runtime } = fakeRuntime();
      expect(
        () => new LlamaCppProvider("gemma-4-e4b", { runtime, contextSize }),
      ).toThrow(InferenceError);
      expect(
        () => new LlamaCppProvider("gemma-4-e4b", { runtime, contextSize }),
      ).toThrow(/llamaCpp\.contextSize must be a positive integer/);
    },
  );

  it("passes llamaCpp.contextSize through makeProviderAsync", async () => {
    const { runtime, recorded } = fakeRuntime();
    const provider = await makeProviderAsync({
      provider: "llama-cpp",
      model: "gemma-4-e4b",
      llamaRuntime: runtime,
      llamaCpp: { contextSize: 4096 },
    });
    await provider.completeJSON(REQUEST);
    expect(recorded.contextSizes).toEqual([4096]);
  });

  it("still works with a runtime that cannot count tokens", async () => {
    // A LlamaRuntime written before the tokenizer and training size joined the
    // seam — every fake in a consumer's suite. It gets the default size and
    // no fit check, which is all a runtime with no real context can use.
    const sizes: number[] = [];
    const runtime: LlamaRuntime = {
      resolveModelFile: (uri) => Promise.resolve(uri),
      loadModel: () =>
        Promise.resolve({
          createSession: (_system: string, contextSize?: number) => {
            if (contextSize != null) sizes.push(contextSize);
            return Promise.resolve({
              prompt: () =>
                Promise.resolve({ text: '{"match":"pass","confidence":0.9}' }),
              dispose: () => Promise.resolve(),
            });
          },
          dispose: () => Promise.resolve(),
        }),
      getMemoryBudgetBytes: () => Promise.resolve(0),
    };
    const result = await new LlamaCppProvider("gemma-4-e4b", {
      runtime,
    }).completeJSON({ ...REQUEST, user: "x".repeat(4 * 20_000) });
    expect(result.json).toEqual({ match: "pass", confidence: 0.9 });
    expect(sizes).toEqual([8192]);
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

  // node-llama-cpp generates under a GBNF grammar built from the schema, and
  // the grammar accounts for the opening `{` itself — so `result.text` comes
  // back starting at the first key, with no `{` in front of it. Every fixture
  // in this file predates that and feeds text *with* the brace, which is why
  // nothing here caught it while `--local` failed on every real run.
  //
  // Both strings below are real `result.text` values captured from
  // Qwen3.5-4B-UD-Q4_K_XL via node-llama-cpp 3.20.0.
  it("restores the opening brace the grammar omits", async () => {
    const { runtime } = fakeRuntime(['"match": "pass",\n"confidence": 0.9\n}']);
    const run = await completeValidatedJSON({
      provider: new LlamaCppProvider("gemma-4-e4b", { runtime }),
      system: REQUEST.system,
      user: REQUEST.user,
      schema: REQUEST.schema,
    });
    expect(run.error).toBeUndefined();
    expect(run.result).toEqual({ match: "pass", confidence: 0.9 });
  });

  it("restores the opening brace when the payload holds an array", async () => {
    // The shape that made this a corruption bug rather than a parse error.
    // Without the leading `{`, extractJson falls back to first-`{`-to-last-`}`
    // — which latches onto the first *array element* and yields
    // `{...},{...}]}`, so the failure surfaced as an opaque
    // "Unexpected non-whitespace character after JSON at position 100".
    const text =
      '"items": [\n  {"match": "pass", "confidence": 0.9},\n' +
      '  {"match": "fail", "confidence": 0.2}\n]\n}';
    const schema = {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object" } },
      },
      required: ["items"],
    } as unknown as Record<string, unknown>;
    const { runtime } = fakeRuntime([text]);
    const run = await completeValidatedJSON({
      provider: new LlamaCppProvider("gemma-4-e4b", { runtime }),
      system: REQUEST.system,
      user: REQUEST.user,
      schema,
    });
    expect(run.error).toBeUndefined();
    expect(run.result).toEqual({
      items: [
        { match: "pass", confidence: 0.9 },
        { match: "fail", confidence: 0.2 },
      ],
    });
  });

  it("leaves a well-formed object alone", async () => {
    // The repair must be a no-op when the brace is present, or it would turn
    // every already-working response into `{{...}`.
    const { runtime } = fakeRuntime(['{"match":"fail","confidence":0.1}']);
    const run = await completeValidatedJSON({
      provider: new LlamaCppProvider("gemma-4-e4b", { runtime }),
      system: REQUEST.system,
      user: REQUEST.user,
      schema: REQUEST.schema,
    });
    expect(run.error).toBeUndefined();
    expect(run.result).toEqual({ match: "fail", confidence: 0.1 });
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

describe("paths that need no weights, verified for real", () => {
  it("resolves the default models directory to a real, usable path", () => {
    // Not a fixed string: assert the contract, so this stays honest wherever
    // HOME points and under INFERENCE_MODELS_DIR.
    const dir = defaultLlamaModelsDirectory();
    expect(isAbsolute(dir)).toBe(true);
    expect(dir).not.toContain(".node-llama-cpp");
    // It must be creatable — the downloader depends on that.
    mkdirSync(dir, { recursive: true });
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("reads the real directory when deciding whether weights are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "inference-provider-"));
    expect(isModelDownloaded("gemma-4-e4b", dir)).toBe(false);
    const uri = LLAMA_MODELS["gemma-4-e4b"]!.uri;
    const [, user] = /^hf:([^/]+)\//.exec(uri)!;
    writeFileSync(join(dir, `hf_${user}_${uri.split("/").pop()}`), Buffer.alloc(4));
    expect(isModelDownloaded("gemma-4-e4b", dir)).toBe(true);
  });

  it("rejects a selector at construction without touching any runtime", () => {
    // No runtime injected at all: if construction consulted one, this would
    // load the native binding instead of throwing.
    expect(() => new LlamaCppProvider("auto")).toThrow(/makeProviderAsync/);
  });

  it("rejects an unknown model reference before any download is attempted", () => {
    expect(() => new LlamaCppProvider("gemma-9-nope")).toThrow(
      /Unknown llama-cpp model/,
    );
  });
});
