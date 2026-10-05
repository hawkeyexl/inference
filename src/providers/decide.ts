/**
 * The decision capability (ADR 01013): probabilities over a fixed set of
 * answers instead of generated text. Optional — a provider opts in by
 * implementing `DecisionProvider`, and callers detect it with `canDecide`.
 * The base `InferenceProvider` contract is unchanged.
 *
 * The request and response follow the shape of TypeSafe's Jev "System One"
 * API, so a provider that forwards to Jev maps one-to-one.
 */
import { InferenceError } from "../types.js";
import type { InferenceProvider, TokenUsage } from "./types.js";

export interface DecideQuestion {
  type: "choice";
  instructions: string;
  /** Option id -> what choosing it means. At least two. */
  criteria: Record<string, string>;
}

export interface DecideRequest {
  /** What the questions are asked about. */
  state: string | Record<string, unknown> | unknown[];
  /** Keyed by question id. At least one. */
  questions: Record<string, DecideQuestion>;
}

export interface DecideAnswer {
  /** The most probable option id. */
  choice: string;
  /** One entry per option id, summing to 1. */
  probabilities: Record<string, number>;
  /** `probabilities[choice]`. */
  confidence: number;
}

export interface DecideResponse {
  /** Keyed by question id. */
  answers: Record<string, DecideAnswer>;
  usage?: TokenUsage;
}

export interface DecisionProvider extends InferenceProvider {
  decide(req: DecideRequest): Promise<DecideResponse>;
  /** Tokens accepted for the state plus the longest question. */
  stateLimit(): Promise<number>;
}

export function canDecide(p: InferenceProvider): p is DecisionProvider {
  const candidate = p as Partial<DecisionProvider>;
  return (
    typeof candidate.decide === "function" &&
    typeof candidate.stateLimit === "function"
  );
}

/** Throws `InferenceError` for a request no provider can answer. */
export function validateDecideRequest(req: DecideRequest): void {
  const entries = Object.entries(req.questions);
  if (entries.length === 0) {
    throw new InferenceError("decide() needs at least one question.");
  }
  for (const [id, question] of entries) {
    if (id === "") {
      throw new InferenceError("decide() question ids must be non-empty strings.");
    }
    if ((question.type as string) !== "choice") {
      throw new InferenceError(
        `decide() question "${id}" has type "${String(question.type)}"; ` +
          `the only question type is "choice".`,
      );
    }
    const options = Object.keys(question.criteria);
    if (options.length < 2) {
      throw new InferenceError(
        `decide() question "${id}" needs at least two criteria, got ${options.length}.`,
      );
    }
    if (options.includes("")) {
      throw new InferenceError(
        `decide() question "${id}" has an empty criterion id.`,
      );
    }
  }
}

/**
 * The one normalization rule every decision provider applies: non-negative
 * weights over the options become probabilities summing to 1 (uniform when
 * every weight is zero), the choice is the most probable option (ties go to
 * the earlier option), and confidence is the choice's probability. Options
 * without a weight get 0.
 */
export function normalizeDecision(
  options: readonly string[],
  weights: Readonly<Record<string, number>>,
): DecideAnswer {
  for (const [option, weight] of Object.entries(weights)) {
    if (!options.includes(option)) {
      throw new InferenceError(
        `Decision weight names "${option}", which is not one of the question's criteria ` +
          `(${options.join(", ")}).`,
      );
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new InferenceError(
        `Decision weight for "${option}" must be a finite, non-negative number, got ${String(weight)}.`,
      );
    }
  }
  const total = options.reduce((sum, option) => sum + (weights[option] ?? 0), 0);
  const probabilities: Record<string, number> = {};
  let choice = options[0] ?? "";
  let confidence = -1;
  for (const option of options) {
    const p = total > 0 ? (weights[option] ?? 0) / total : 1 / options.length;
    probabilities[option] = p;
    if (p > confidence) {
      choice = option;
      confidence = p;
    }
  }
  return { choice, probabilities, confidence };
}
