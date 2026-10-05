/**
 * The `jev` provider: TypeSafe's hosted "System One" API, which answers a
 * question over a fixed set of options with a probability for each (ADR 01015).
 *
 * It is a `DecisionProvider` and nothing else. Jev does not generate text, so
 * `completeJSON` refuses, and detection never picks it: it needs a paid key
 * and cannot stand in for the providers that do answer `completeJSON`.
 *
 * The decision request shape was copied from this API (ADR 01013), so the
 * request mapping below is one-to-one. It lives in `toJevRequest` so there is
 * one place to change if Jev's wire format moves.
 */
import { InferenceError } from "../types.js";
import { normalizeDecision, validateDecideRequest } from "./decide.js";
import type { DecideAnswer, DecideRequest, DecideResponse, DecisionProvider } from "./decide.js";
import type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  TokenUsage,
} from "./types.js";

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";

/** Tokens for the state plus the longest question; the request as a whole takes 64k. */
const STATE_LIMIT_TOKENS = 32_000;

/** Jev's cap on options in one choice question. */
const MAX_OPTIONS = 255;

const DEFAULT_TIMEOUT_MS = 60_000;

export interface JevProviderOptions {
  /** Default `https://api.typesafe.ai`. */
  baseUrl?: string;
  /** Per-request timeout. Default 60000. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The body Jev's `/v1/systemone` takes. */
export interface JevRequest {
  model: string;
  state: DecideRequest["state"];
  questions: Record<
    string,
    { type: "choice"; instructions: string; criteria: Record<string, string> }
  >;
}

/**
 * Map a decision request onto Jev's. A choice question's `criteria` is an
 * object of option id to a description of what choosing it means, the same as
 * ours, so nothing is rewritten.
 */
export function toJevRequest(model: string, req: DecideRequest): JevRequest {
  const questions: JevRequest["questions"] = {};
  for (const [id, q] of Object.entries(req.questions)) {
    questions[id] = {
      type: "choice",
      instructions: q.instructions,
      criteria: { ...q.criteria },
    };
  }
  return { model, state: req.state, questions };
}

export class JevProvider implements DecisionProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly model: string,
    private readonly apiKeyEnv: string,
    options: JevProviderOptions = {},
  ) {
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new InferenceError(
        `Jev provider needs ${apiKeyEnv} set (or choose another provider)`,
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_JEV_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  provider(): string {
    return "jev";
  }

  modelName(): string {
    return this.model;
  }

  completeJSON(_req: CompleteJSONRequest): Promise<CompleteJSONResponse> {
    return Promise.reject(
      new InferenceError(
        "The jev provider answers decisions only and cannot generate JSON. " +
          "Call decide() on a provider that canDecide, or choose another provider for completeJSON.",
      ),
    );
  }

  stateLimit(): Promise<number> {
    return Promise.resolve(STATE_LIMIT_TOKENS);
  }

  async decide(req: DecideRequest): Promise<DecideResponse> {
    validateDecideRequest(req);
    for (const [id, question] of Object.entries(req.questions)) {
      const count = Object.keys(question.criteria).length;
      if (count > MAX_OPTIONS) {
        throw new InferenceError(
          `decide() question "${id}" has ${count} criteria; Jev accepts at most ${MAX_OPTIONS}.`,
        );
      }
    }
    const body = await this.post(toJevRequest(this.model, req));
    return fromJevResponse(body, req);
  }

  private async post(body: JevRequest): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new InferenceError(`Jev request timed out after ${this.timeoutMs}ms.`);
      }
      throw new InferenceError(
        `Jev request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw this.httpError(response.status, text);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unreadable("the body is not JSON");
    }
  }

  private httpError(status: number, text: string): InferenceError {
    const detail = detailOf(text);
    const suffix = detail ? `: ${detail}` : "";
    switch (status) {
      case 401:
        return new InferenceError(
          `Jev rejected the API key (HTTP 401). Check ${this.apiKeyEnv}${suffix}`,
        );
      case 422:
        return new InferenceError(
          `Jev rejected the request as invalid (HTTP 422)${suffix}`,
        );
      case 429:
        return new InferenceError(
          `Jev rate limit exceeded (HTTP 429). Retry with backoff${suffix}`,
        );
      case 529:
        return new InferenceError(
          `Jev is overloaded (HTTP 529). Retry with backoff${suffix}`,
        );
      default:
        return new InferenceError(`Jev request failed with HTTP ${status}${suffix}`);
    }
  }
}

function fromJevResponse(body: unknown, req: DecideRequest): DecideResponse {
  const answersIn = asRecord(asRecord(body)?.["answers"]);
  if (!answersIn) throw unreadable("it has no answers");
  const answers: Record<string, DecideAnswer> = {};
  for (const [id, question] of Object.entries(req.questions)) {
    const answer = asRecord(answersIn[id]);
    if (!answer) throw unreadable(`it has no answer for question "${id}"`);
    if (answer["type"] !== "choice") {
      throw unreadable(`the answer to "${id}" is not a choice`);
    }
    const probabilities = asRecord(answer["probabilities"]);
    if (!probabilities) throw unreadable(`the answer to "${id}" has no probabilities`);
    // Jev's own `choice` and `confidence` are not used: the shared rule derives
    // both from the probabilities, so they mean the same on every provider.
    answers[id] = normalizeDecision(
      Object.keys(question.criteria),
      probabilities as Record<string, number>,
    );
  }
  const usage = usageOf(asRecord(asRecord(body)?.["usage"]));
  return usage ? { answers, usage } : { answers };
}

function usageOf(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  const input = usage?.["input_tokens"];
  const output = usage?.["output_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return { inputTokens: input, outputTokens: output };
}

function unreadable(why: string): InferenceError {
  return new InferenceError(`Jev returned a response this library cannot read: ${why}.`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Jev's explanation from an error body, or the start of the body itself. */
function detailOf(text: string): string {
  try {
    const body = asRecord(JSON.parse(text) as unknown);
    const error = body?.["error"];
    const candidates = [
      error,
      asRecord(error)?.["message"],
      body?.["message"],
      body?.["detail"],
    ];
    const found = candidates.find((c): c is string => typeof c === "string" && c !== "");
    return found ?? "";
  } catch {
    return text.trim().slice(0, 200);
  }
}
