/**
 * Decisions on the llama-cpp provider: the prompt it renders, the letters it
 * asks for, and how letter probabilities become an answer. ADR 01016.
 *
 * The injected `LlamaRuntime` is the permitted double for inference over GGUF
 * weights. The worker side, where the prompt meets a context sequence, runs
 * for real in `llama-worker.test.ts`; real weights run in the live suite.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  InferenceError,
  LlamaCppProvider,
  canDecide,
  disposeLlamaModels,
} from "../../src/index.js";
import type {
  DecideRequest,
  LlamaDecideOptions,
  LlamaDecideResult,
  LlamaRuntime,
} from "../../src/index.js";

const fakeTokens = (text: string): number => Math.ceil(text.length / 4);

interface Recorded {
  systemPrompts: string[];
  contextSizes: (number | undefined)[];
  decides: LlamaDecideOptions[];
  disposed: number;
}

function runtime(
  answer: (options: LlamaDecideOptions) => Partial<LlamaDecideResult> = (o) => ({
    weights: o.labels.map(() => ({})),
  }),
  { trainContextSize = 131_072, decide = true }: { trainContextSize?: number; decide?: boolean } = {},
): { runtime: LlamaRuntime; recorded: Recorded } {
  const recorded: Recorded = { systemPrompts: [], contextSizes: [], decides: [], disposed: 0 };
  return {
    recorded,
    runtime: {
      resolveModelFile: (uri, directory) => Promise.resolve(`${directory}/${uri}`),
      getMemoryBudgetBytes: () => Promise.resolve(16e9),
      loadModel: () =>
        Promise.resolve({
          trainContextSize,
          countTokens: fakeTokens,
          dispose: () => Promise.resolve(),
          createSession(systemPrompt, contextSize) {
            recorded.systemPrompts.push(systemPrompt);
            recorded.contextSizes.push(contextSize);
            return Promise.resolve({
              contextSize,
              prompt: () => Promise.reject(new Error("decide must not prompt")),
              dispose: () => {
                recorded.disposed++;
                return Promise.resolve();
              },
              ...(decide
                ? {
                    decide(options: LlamaDecideOptions) {
                      recorded.decides.push(options);
                      return Promise.resolve({
                        weights: [],
                        usage: { inputTokens: 100, outputTokens: 0 },
                        ...answer(options),
                      });
                    },
                  }
                : {}),
            });
          },
        }),
    },
  };
}

const REQUEST: DecideRequest = {
  state: "The agent ran `git commit --no-verify`.",
  questions: {
    hooks: {
      type: "choice",
      instructions: "Did the agent skip a git hook?",
      criteria: { yes: "It skipped a hook.", no: "It ran every hook." },
    },
    tone: {
      type: "choice",
      instructions: "How did the agent word its summary?",
      criteria: { plain: "Plainly.", hedged: "With hedges.", absent: "" },
    },
  },
};

beforeEach(async () => {
  await disposeLlamaModels();
});

describe("LlamaCppProvider decisions", () => {
  it("is a decision provider", () => {
    expect(canDecide(new LlamaCppProvider("qwen3.5-4b", { runtime: runtime().runtime }))).toBe(true);
  });

  it("renders one prompt per question, sharing the state and lettering the options", async () => {
    const { runtime: r, recorded } = runtime();
    await new LlamaCppProvider("qwen3.5-4b", { runtime: r }).decide(REQUEST);
    const [options] = recorded.decides;
    expect(options!.answerPrefix).toBe("Answer:");
    expect(options!.labels).toEqual([["A", "B"], ["A", "B", "C"]]);
    expect(options!.prompts).toEqual([
      "# State\n\nThe agent ran `git commit --no-verify`.\n\n# Question\n\n" +
        "Did the agent skip a git hook?\n\nA. It skipped a hook.\nB. It ran every hook.\n\n" +
        "Reply with the letter of one option.",
      "# State\n\nThe agent ran `git commit --no-verify`.\n\n# Question\n\n" +
        "How did the agent word its summary?\n\nA. Plainly.\nB. With hedges.\nC. absent\n\n" +
        "Reply with the letter of one option.",
    ]);
    // One session, under the fixed decision instruction, disposed afterwards.
    expect(recorded.systemPrompts).toHaveLength(1);
    expect(recorded.systemPrompts[0]).toMatch(/letter/);
    expect(recorded.disposed).toBe(1);
  });

  it("renders an object or array state as indented JSON", async () => {
    const { runtime: r, recorded } = runtime();
    const provider = new LlamaCppProvider("qwen3.5-4b", { runtime: r });
    await provider.decide({ ...REQUEST, state: { turn: 3, tools: ["Bash"] } });
    await provider.decide({ ...REQUEST, state: [1, 2] });
    expect(recorded.decides[0]!.prompts[0]).toContain(
      '# State\n\n{\n  "turn": 3,\n  "tools": [\n    "Bash"\n  ]\n}\n\n# Question',
    );
    expect(recorded.decides[1]!.prompts[0]).toContain("# State\n\n[\n  1,\n  2\n]\n\n# Question");
  });

  it("maps letter probabilities back to option ids and renormalizes them", async () => {
    const { runtime: r } = runtime(() => ({
      // Option letters take only part of the mass; the rest went elsewhere.
      weights: <Record<string, number>[]>[
        { A: 0.375, B: 0.125 },
        { A: 0.05, B: 0.15, C: 0 },
      ],
    }));
    const result = await new LlamaCppProvider("qwen3.5-4b", { runtime: r }).decide(REQUEST);
    expect(result.answers["hooks"]).toEqual({
      choice: "yes",
      probabilities: { yes: 0.75, no: 0.25 },
      confidence: 0.75,
    });
    expect(result.answers["tone"]!.choice).toBe("hedged");
    expect(result.answers["tone"]!.probabilities["hedged"]).toBeCloseTo(0.75);
    expect(result.answers["tone"]!.probabilities["absent"]).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 0 });
  });

  it("answers uniformly when the model put no mass on any letter", async () => {
    const { runtime: r } = runtime((o) => ({ weights: o.labels.map(() => ({})) }));
    const result = await new LlamaCppProvider("qwen3.5-4b", { runtime: r }).decide(REQUEST);
    expect(result.answers["hooks"]).toEqual({
      choice: "yes",
      probabilities: { yes: 0.5, no: 0.5 },
      confidence: 0.5,
    });
  });

  it("validates the request before loading anything", async () => {
    const { runtime: r, recorded } = runtime();
    await expect(
      new LlamaCppProvider("qwen3.5-4b", { runtime: r }).decide({ state: "", questions: {} }),
    ).rejects.toThrow("decide() needs at least one question.");
    expect(recorded.systemPrompts).toEqual([]);
  });

  it("refuses more options than there are letters", async () => {
    const criteria = Object.fromEntries(
      Array.from({ length: 27 }, (_, i) => [`o${i}`, `option ${i}`]),
    );
    const { runtime: r } = runtime();
    const error = await new LlamaCppProvider("qwen3.5-4b", { runtime: r })
      .decide({ state: "", questions: { many: { type: "choice", instructions: "", criteria } } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toBe(
      'llama-cpp decide() question "many" has 27 criteria; it letters options A to Z, so 26 at most.',
    );
  });

  it("sizes the context to the longest question", async () => {
    const { runtime: r, recorded } = runtime();
    const long = "x".repeat(40_000);
    await new LlamaCppProvider("qwen3.5-4b", { runtime: r }).decide({
      ...REQUEST,
      questions: {
        ...REQUEST.questions,
        long: { type: "choice", instructions: long, criteria: { a: "", b: "" } },
      },
    });
    // 10000 tokens of question alone: past the 8192 default, so sized up.
    expect(recorded.contextSizes[0]).toBeGreaterThan(10_000);
    expect(recorded.contextSizes[0]).toBeLessThan(11_000);
  });

  it("refuses a state that does not fit the training context", async () => {
    const { runtime: r, recorded } = runtime(undefined, { trainContextSize: 4096 });
    const error = await new LlamaCppProvider("qwen3.5-4b", { runtime: r })
      .decide({ ...REQUEST, state: "x".repeat(20_000) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toMatch(
      /^llama-cpp prompt needs \d+ tokens of context, more than this model's training context of 4096 tokens\./,
    );
    expect(recorded.systemPrompts).toEqual([]);
  });

  it("reports the state limit the context sizing enforces", async () => {
    const { runtime: r } = runtime(undefined, { trainContextSize: 32_768 });
    const provider = new LlamaCppProvider("qwen3.5-4b", { runtime: r });
    const limit = await provider.stateLimit();
    expect(limit).toBeGreaterThan(30_000);
    expect(limit).toBeLessThan(32_768 - 512);
    // State plus question at exactly the limit fits, with the provider's own
    // framing (headings, letters) covered; well past it is refused.
    const fits = (tokens: number) =>
      provider.decide({
        state: "",
        questions: { q: { type: "choice", instructions: "x".repeat(tokens * 4), criteria: { a: "", b: "" } } },
      });
    await expect(fits(limit)).resolves.toBeDefined();
    await expect(fits(limit + 200)).rejects.toThrow(/training context of 32768 tokens/);
  });

  it("bounds the state limit by llamaCpp.contextSize when it is set", async () => {
    const { runtime: r } = runtime();
    const limit = await new LlamaCppProvider("qwen3.5-4b", { runtime: r, contextSize: 4096 }).stateLimit();
    expect(limit).toBeGreaterThan(3000);
    expect(limit).toBeLessThan(4096 - 512);
  });

  it("rejects when the runtime's sessions cannot decide", async () => {
    const { runtime: r, recorded } = runtime(undefined, { decide: false });
    await expect(new LlamaCppProvider("qwen3.5-4b", { runtime: r }).decide(REQUEST)).rejects.toThrow(
      "This llama-cpp runtime's sessions have no decide(), so the provider cannot answer decisions.",
    );
    expect(recorded.disposed).toBe(1);
  });
});
