/**
 * Mock provider for tests and offline development. Responds with scripted
 * results in order, cycling when exhausted. Exported from the public API so
 * downstream consumers can test their own pipelines without a live provider.
 */
import type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  InferenceProvider,
  TokenUsage,
} from "./types.js";

export type MockResponse =
  | { json: unknown; usage?: TokenUsage }
  | { error: string };

export class MockProvider implements InferenceProvider {
  private calls = 0;
  /** Every request seen, in order — assert against this in tests. */
  public readonly requests: CompleteJSONRequest[] = [];

  constructor(
    private readonly responses: MockResponse[],
    private readonly model = "mock-model",
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
      usage: response.usage ?? { inputTokens: 500, outputTokens: 100 },
    });
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
