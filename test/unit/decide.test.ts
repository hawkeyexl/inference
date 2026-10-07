/**
 * The decision capability (ADR 01013): `canDecide`, request validation, the
 * shared normalization rule, and `MockProvider`'s decisions. `MockProvider` is
 * the permitted double for a remote LLM API; everything else runs for real.
 */
import { describe, expect, it } from "vitest";
import {
  InferenceError,
  MockProvider,
  canDecide,
  makeProvider,
} from "../../src/index.js";
import type { DecideRequest, InferenceProvider } from "../../src/index.js";
import {
  normalizeDecision,
  validateDecideRequest,
} from "../../src/providers/decide.js";

const request: DecideRequest = {
  state: { tool: "Bash", command: "git push --no-verify" },
  questions: {
    hooks: {
      type: "choice",
      instructions: "Did the agent skip a git hook?",
      criteria: { yes: "a hook was skipped", no: "no hook was skipped" },
    },
    tone: {
      type: "choice",
      instructions: "How did the agent phrase it?",
      criteria: { plain: "plain", hedged: "hedged", rude: "rude" },
    },
  },
};

describe("canDecide", () => {
  it("is true for a provider with decide and stateLimit", () => {
    expect(canDecide(new MockProvider([{ json: {} }]))).toBe(true);
  });

  it("is false for a provider with only completeJSON", () => {
    const plain: InferenceProvider = {
      provider: () => "x",
      modelName: () => "y",
      completeJSON: () => Promise.resolve({ json: {} }),
    };
    expect(canDecide(plain)).toBe(false);
  });
});

describe("validateDecideRequest", () => {
  const question = request.questions["hooks"]!;

  it("accepts a well-formed request", () => {
    expect(() => validateDecideRequest(request)).not.toThrow();
  });

  it("refuses a request with no questions", () => {
    expect(() => validateDecideRequest({ state: "", questions: {} })).toThrow(
      new InferenceError("decide() needs at least one question."),
    );
  });

  it("refuses an empty question id", () => {
    expect(() =>
      validateDecideRequest({ state: "", questions: { "": question } }),
    ).toThrow(/question ids must be non-empty/);
  });

  it("refuses a question with fewer than two criteria", () => {
    expect(() =>
      validateDecideRequest({
        state: "",
        questions: { q: { ...question, criteria: { only: "one" } } },
      }),
    ).toThrow(/question "q" needs at least two criteria, got 1/);
  });

  it("refuses an empty criterion id", () => {
    expect(() =>
      validateDecideRequest({
        state: "",
        questions: { q: { ...question, criteria: { "": "blank", no: "no" } } },
      }),
    ).toThrow(/question "q" has an empty criterion id/);
  });

  it("refuses a type other than choice", () => {
    const bad = { ...question, type: "number" } as unknown as typeof question;
    expect(() =>
      validateDecideRequest({ state: "", questions: { q: bad } }),
    ).toThrow(InferenceError);
  });
});

describe("normalizeDecision", () => {
  it("normalizes weights to sum to 1 and sets confidence to the choice's probability", () => {
    const answer = normalizeDecision(["a", "b", "c"], { a: 1, b: 3 });
    expect(answer.choice).toBe("b");
    expect(answer.probabilities).toEqual({ a: 0.25, b: 0.75, c: 0 });
    expect(answer.confidence).toBe(0.75);
  });

  it("breaks ties by criteria order", () => {
    expect(normalizeDecision(["a", "b"], { a: 2, b: 2 }).choice).toBe("a");
  });

  it("is uniform when every weight is zero", () => {
    const answer = normalizeDecision(["a", "b"], {});
    expect(answer).toEqual({
      choice: "a",
      probabilities: { a: 0.5, b: 0.5 },
      confidence: 0.5,
    });
  });

  it("refuses a weight for an option that is not a criterion", () => {
    expect(() => normalizeDecision(["a", "b"], { z: 1 })).toThrow(
      /names "z", which is not one of the question's criteria/,
    );
  });

  it("refuses a negative or non-finite weight", () => {
    expect(() => normalizeDecision(["a", "b"], { a: -1 })).toThrow(InferenceError);
    expect(() => normalizeDecision(["a", "b"], { a: Number.NaN })).toThrow(
      InferenceError,
    );
  });
});

describe("MockProvider decisions", () => {
  it("answers an unscripted question uniformly, choosing the first option", async () => {
    const provider = new MockProvider([{ json: {} }]);
    const response = await provider.decide(request);
    expect(response.answers["tone"]).toEqual({
      choice: "plain",
      probabilities: { plain: 1 / 3, hedged: 1 / 3, rude: 1 / 3 },
      confidence: 1 / 3,
    });
    expect(response.usage).toEqual({ inputTokens: 500, outputTokens: 100 });
    expect(provider.decideRequests).toEqual([request]);
  });

  it("takes a scripted choice or scripted weights per question id", async () => {
    const provider = new MockProvider([{ json: {} }], "mock-model", {
      decisions: { hooks: "yes", tone: { hedged: 4, plain: 1 } },
    });
    const { answers } = await provider.decide(request);
    expect(answers["hooks"]).toEqual({
      choice: "yes",
      probabilities: { yes: 1, no: 0 },
      confidence: 1,
    });
    expect(answers["tone"]?.choice).toBe("hedged");
    expect(answers["tone"]?.confidence).toBeCloseTo(0.8);
  });

  it("takes a function of the question id, question and state", async () => {
    const provider = new MockProvider([{ json: {} }], "mock-model", {
      decisions: (id, question, state) => {
        expect(question.criteria).toBeDefined();
        expect(state).toBe(request.state);
        return id === "hooks" ? "no" : "rude";
      },
    });
    const { answers } = await provider.decide(request);
    expect(answers["hooks"]?.choice).toBe("no");
    expect(answers["tone"]?.choice).toBe("rude");
  });

  it("rejects a scripted choice that is not a criterion", async () => {
    const provider = new MockProvider([{ json: {} }], "mock-model", {
      decisions: { hooks: "maybe" },
    });
    await expect(provider.decide(request)).rejects.toThrow(InferenceError);
  });

  it("rejects an invalid request with InferenceError", async () => {
    const provider = new MockProvider([{ json: {} }]);
    await expect(provider.decide({ state: "", questions: {} })).rejects.toThrow(
      InferenceError,
    );
  });

  it("reports a configurable state limit, 8192 by default", async () => {
    expect(await new MockProvider([{ json: {} }]).stateLimit()).toBe(8192);
    const small = new MockProvider([{ json: {} }], "mock-model", { stateLimit: 512 });
    expect(await small.stateLimit()).toBe(512);
  });

  it("is configured through ProviderSpec", async () => {
    const provider = makeProvider({
      provider: "mock",
      mockDecisions: { hooks: "yes" },
      mockStateLimit: 1024,
    });
    if (!canDecide(provider)) throw new Error("mock must be a DecisionProvider");
    expect(await provider.stateLimit()).toBe(1024);
    expect((await provider.decide(request)).answers["hooks"]?.choice).toBe("yes");
  });
});
