/**
 * Mock provider for tests and offline development. Responds with scripted
 * results in order, cycling when exhausted. Exported from the public API so
 * downstream consumers can test their own pipelines without a live provider.
 * It is also a `DecisionProvider`, so decision pipelines test offline too.
 */
import { normalizeDecision, validateDecideRequest } from "./decide.js";
import type {
  DecideAnswer,
  DecideQuestion,
  DecideRequest,
  DecideResponse,
  DecisionProvider,
} from "./decide.js";
import type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  InferenceProvider,
  TokenUsage,
} from "./types.js";

export type MockResponse =
  | { json: unknown; usage?: TokenUsage }
  | { error: string };

/**
 * A scripted answer to one decision question: an option id (probability 1),
 * or weights over option ids, normalized by the shared rule.
 */
export type MockDecision = string | Record<string, number>;

/**
 * Per question id, or a function of the question. A question with no script
 * (or a function returning `undefined`) gets uniform probabilities, so the
 * first option wins with the lowest confidence the question allows.
 */
export type MockDecisions =
  | Record<string, MockDecision>
  | ((
      questionId: string,
      question: DecideQuestion,
      state: DecideRequest["state"],
    ) => MockDecision | undefined);

export interface MockProviderOptions {
  decisions?: MockDecisions;
  /** What `stateLimit()` reports. Default 8192. */
  stateLimit?: number;
}

const DEFAULT_USAGE = { inputTokens: 500, outputTokens: 100 };

export class MockProvider implements DecisionProvider {
  private calls = 0;
  /** Every request seen, in order — assert against this in tests. */
  public readonly requests: CompleteJSONRequest[] = [];
  /** Every `decide` request seen, in order. */
  public readonly decideRequests: DecideRequest[] = [];

  constructor(
    private readonly responses: MockResponse[],
    private readonly model = "mock-model",
    private readonly options: MockProviderOptions = {},
  ) {
    if (responses.length === 0) {
      throw new Error("MockProvider needs at least one scripted response");
    }
  }

  provider(): string {
    return "mock";
  }

  modelName(): string {
    return this.model;
  }

  completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResponse> {
    this.requests.push(req);
    const response = this.responses[this.calls % this.responses.length]!;
    this.calls += 1;
    if ("error" in response) {
      return Promise.reject(new Error(response.error));
    }
    return Promise.resolve({
      json: response.json,
      usage: response.usage ?? DEFAULT_USAGE,
    });
  }

  decide(req: DecideRequest): Promise<DecideResponse> {
    try {
      this.decideRequests.push(req);
      validateDecideRequest(req);
      const answers: Record<string, DecideAnswer> = {};
      for (const [id, question] of Object.entries(req.questions)) {
        const script = this.options.decisions;
        const scripted =
          typeof script === "function"
            ? script(id, question, req.state)
            : script?.[id];
        const weights =
          typeof scripted === "string" ? { [scripted]: 1 } : (scripted ?? {});
        answers[id] = normalizeDecision(Object.keys(question.criteria), weights);
      }
      return Promise.resolve({ answers, usage: DEFAULT_USAGE });
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  stateLimit(): Promise<number> {
    return Promise.resolve(this.options.stateLimit ?? 8192);
  }
}

/** Convenience: a scripted response shaped like the canonical judge verdict. */
export function mockVerdict(
  match: "pass" | "fail" | "partial",
  confidence: number,
  overrides: Partial<{
    claim: string;
    observed: string;
    reasoning: string;
  }> = {},
): { json: unknown } {
  return {
    json: {
      claim: overrides.claim ?? "The assertion under test",
      observed: overrides.observed ?? "Observed content",
      match,
      confidence,
      reasoning: overrides.reasoning ?? "Scripted mock reasoning",
    },
  };
}
