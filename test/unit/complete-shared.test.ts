/**
 * `completeJSONShared`: N schema-validated answers over one shared prefix.
 * ADR 01018.
 *
 * The providers without a native path fall back to one validated call per
 * item. `MockProvider` and the slow provider below stand in for a remote LLM
 * API, the permitted double; the Claude CLI case spawns real processes and
 * fakes only what `claude -p` would return. The local provider's native path
 * runs in the real worker in `llama-worker.test.ts`; here a fake `LlamaRuntime`
 * pins only what the provider hands its session.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeCliProvider,
  InferenceError,
  LlamaCppProvider,
  MockProvider,
  completeJSONShared,
  disposeLlamaModels,
  realExec,
} from "../../src/index.js";
import type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  InferenceProvider,
  LlamaRuntime,
  LlamaSession,
  LlamaSharedOptions,
} from "../../src/index.js";
import { writeFakeCli } from "../support/fake-cli.js";

const SCHEMA = {
  type: "object",
  properties: { n: { type: "integer", minimum: 0, maximum: 100 } },
  required: ["n"],
  additionalProperties: false,
};

const BASE = { system: "You judge.", shared: "TURN\n\n", schema: SCHEMA };

/** A remote API that takes `ms` to answer, counting calls in flight. */
class SlowProvider implements InferenceProvider {
  inFlight = 0;
  peak = 0;
  readonly users: string[] = [];
  constructor(private readonly ms: number) {}
  provider(): string {
    return "slow";
  }
  modelName(): string {
    return "slow-model";
  }
  async completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResponse> {
    this.users.push(req.user);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((r) => setTimeout(r, this.ms));
    this.inFlight -= 1;
    return { json: { n: this.users.indexOf(req.user) }, usage: { inputTokens: 3, outputTokens: 1 } };
  }
}

describe("completeJSONShared, on a provider without a native path", () => {
  it("answers each item from the mock's scripted responses, in item order", async () => {
    const provider = new MockProvider([{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }]);
    const response = await completeJSONShared(provider, { ...BASE, items: ["a", "b", "c"] });
    expect(response.answers).toEqual([{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }]);
    expect(provider.requests.map((r) => [r.system, r.user, r.temperature])).toEqual([
      ["You judge.", "TURN\n\na", 0],
      ["You judge.", "TURN\n\nb", 0],
      ["You judge.", "TURN\n\nc", 0],
    ]);
    expect(provider.requests[0]!.schema).toBe(SCHEMA);
    expect(response.usage).toEqual({ inputTokens: 1500, outputTokens: 300 });
    expect(response.reuse).toBeUndefined();
  });

  it("passes the temperature through", async () => {
    const provider = new MockProvider([{ json: { n: 1 } }]);
    await completeJSONShared(provider, { ...BASE, items: ["a"], temperature: 0.7 });
    expect(provider.requests[0]!.temperature).toBe(0.7);
  });

  it("records an item that fails validation twice as an error, and answers the rest", async () => {
    const provider = new MockProvider([
      { json: { n: 1 } },
      { json: { n: 1000 } },
      { error: "rate limited" },
    ]);
    const response = await completeJSONShared(provider, { ...BASE, items: ["a", "b"] });
    expect(response.answers[0]).toEqual({ json: { n: 1 } });
    // b: n 1000 fails the schema, and its retry is rejected by the provider.
    expect(response.answers[1]).toEqual({ error: "rate limited" });
  });

  it("records a schema failure in completeValidatedJSON's words", async () => {
    const provider = new MockProvider([{ json: { n: "x" } }]);
    const response = await completeJSONShared(provider, { ...BASE, items: ["a"] });
    expect(response.answers).toEqual([
      { error: "Response failed schema validation: /n must be integer" },
    ]);
  });

  it("returns no answers, and calls nothing, for no items", async () => {
    const provider = new MockProvider([{ json: { n: 1 } }]);
    expect(await completeJSONShared(provider, { ...BASE, items: [] })).toEqual({ answers: [] });
    expect(provider.requests).toHaveLength(0);
  });

  it("runs at most 8 calls at once by default", async () => {
    const provider = new SlowProvider(30);
    const items = Array.from({ length: 20 }, (_, i) => `item ${i}`);
    const response = await completeJSONShared(provider, { ...BASE, items });
    expect(provider.peak).toBe(8);
    expect(response.answers).toHaveLength(20);
    // Each answer is its own item's, whatever order the calls finished in.
    response.answers.forEach((answer, i) => {
      expect(answer).toEqual({ json: { n: provider.users.indexOf(`TURN\n\nitem ${i}`) } });
    });
    expect(response.usage).toEqual({ inputTokens: 60, outputTokens: 20 });
  });

  it("runs at most `concurrency` calls at once", async () => {
    const provider = new SlowProvider(20);
    await completeJSONShared(provider, { ...BASE, items: ["a", "b", "c", "d", "e"], concurrency: 2 });
    expect(provider.peak).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects concurrency %s", async (concurrency) => {
    const provider = new MockProvider([{ json: { n: 1 } }]);
    const call = completeJSONShared(provider, { ...BASE, items: ["a"], concurrency });
    await expect(call).rejects.toThrow(InferenceError);
    await expect(call).rejects.toThrow(/concurrency must be a positive integer/);
  });

  it("falls back on the Claude CLI, one real process per item", async () => {
    const cli = writeFakeCli(
      `const n = stdin.includes("second") ? 2 : 1;\n` +
        `process.stdout.write(JSON.stringify({ result: JSON.stringify({ n }) }));`,
    );
    const provider = new ClaudeCliProvider("sonnet", cli.command, realExec);
    const response = await completeJSONShared(provider, { ...BASE, items: ["first", "second"] });
    expect(response.answers).toEqual([{ json: { n: 1 } }, { json: { n: 2 } }]);
    const calls = readFileSync(cli.recordPath, "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(response.usage).toBeUndefined();
  }, 60_000);
});

describe("completeJSONShared, on the local provider's native path", () => {
  // Loaded models are process-wide; each test's fake runtime must load its own.
  beforeEach(() => disposeLlamaModels());

  /** A runtime whose one session records what it was asked and answers `outputs`. */
  function runtime(session: Partial<LlamaSession>): {
    runtime: LlamaRuntime;
    seen: { systemPrompt: string; contextSize?: number; options?: LlamaSharedOptions };
  } {
    const seen: { systemPrompt: string; contextSize?: number; options?: LlamaSharedOptions } = {
      systemPrompt: "",
    };
    return {
      seen,
      runtime: {
        resolveModelFile: (uri) => Promise.resolve(uri),
        getMemoryBudgetBytes: () => Promise.resolve(16e9),
        loadModel: () =>
          Promise.resolve({
            trainContextSize: 131_072,
            countTokens: (text: string) => Math.ceil(text.length / 4),
            createSession(systemPrompt: string, contextSize?: number) {
              seen.systemPrompt = systemPrompt;
              seen.contextSize = contextSize;
              return Promise.resolve({
                contextSize,
                prompt: () => Promise.reject(new Error("not used")),
                dispose: () => Promise.resolve(),
                ...session,
              });
            },
            dispose: () => Promise.resolve(),
          }),
      },
    };
  }

  it("hands the session one whole user turn per item, and the schema", async () => {
    const { runtime: rt, seen } = runtime({
      completeShared(options) {
        seen.options = options;
        return Promise.resolve({
          outputs: options.prompts.map((_, i) => ({ text: `{"n": ${i}}`, stopReason: "eogToken" })),
          usage: { inputTokens: 10, outputTokens: 4 },
          reuse: "erase",
        });
      },
    });
    const provider = new LlamaCppProvider("gemma-4-e4b", { runtime: rt });
    const long = "x".repeat(40_000);
    const response = await completeJSONShared(provider, { ...BASE, items: ["a", long] });
    expect(response).toEqual({
      answers: [{ json: { n: 0 } }, { json: { n: 1 } }],
      usage: { inputTokens: 10, outputTokens: 4 },
      reuse: "erase",
    });
    expect(seen.options!.prompts).toEqual(["TURN\n\na", `TURN\n\n${long}`]);
    expect(seen.options!.schema).toEqual(SCHEMA);
    expect(seen.options!.temperature).toBe(0);
    // The schema is restated, since the grammar does not show the model its descriptions.
    expect(seen.systemPrompt).toContain("You judge.");
    expect(seen.systemPrompt).toContain(JSON.stringify(SCHEMA));
    // Sized for the longest item, with room for its answer.
    expect(seen.contextSize).toBeGreaterThan(10_000);
    expect(seen.options!.maxTokens).toBe(seen.contextSize! - Math.ceil(`TURN\n\n${long}`.length / 4) - Math.ceil(seen.systemPrompt.length / 4) - 512);
  });

  it("restores the brace a grammar leaves off", async () => {
    const { runtime: rt } = runtime({
      completeShared: () =>
        Promise.resolve({ outputs: [{ text: `"n": 7}`, stopReason: "eogToken" }] }),
    });
    const response = await completeJSONShared(new LlamaCppProvider("gemma-4-e4b", { runtime: rt }), {
      ...BASE,
      items: ["a"],
    });
    expect(response.answers).toEqual([{ json: { n: 7 } }]);
  });

  it("refuses a runtime whose sessions cannot complete over a shared prefix", async () => {
    const { runtime: rt } = runtime({});
    const call = completeJSONShared(new LlamaCppProvider("gemma-4-e4b", { runtime: rt }), {
      ...BASE,
      items: ["a"],
    });
    await expect(call).rejects.toThrow(InferenceError);
    await expect(call).rejects.toThrow(/sessions have no completeShared\(\)/);
  });

  it("refuses, before generating, an item that does not fit the context", async () => {
    const { runtime: rt, seen } = runtime({
      completeShared: () => Promise.reject(new Error("not reached")),
    });
    const provider = new LlamaCppProvider("gemma-4-e4b", { runtime: rt, contextSize: 4096 });
    const call = completeJSONShared(provider, { ...BASE, items: ["a", "x".repeat(20_000)] });
    await expect(call).rejects.toThrow(/more than llamaCpp\.contextSize \(4096\)/);
    expect(seen.options).toBeUndefined();
  });
});
