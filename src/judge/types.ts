/**
 * LLM-as-judge types. The verdict shape is the one all consuming projects
 * already share; the canonical schema lives in verdict-schema.json and is
 * overridable per consumer so domain-specific field descriptions survive
 * (ADR 01001).
 */
import verdictSchemaJson from "./verdict-schema.json" with { type: "json" };
import type { TokenUsage } from "../providers/types.js";

export const VERDICT_SCHEMA = verdictSchemaJson as Record<string, unknown>;

export type Match = "pass" | "fail" | "partial";

/** Confidence-zone routing for LLM-judged evals. */
export type Zone = "auto-pass" | "auto-fail" | "human-review";

export interface JudgeVerdict {
  /** The specific assertion under evaluation. */
  claim: string;
  /** What the judge actually observed. */
  observed: string;
  match: Match;
  /** 0.0–1.0 self-reported confidence. */
  confidence: number;
  reasoning: string;
}

/** One run within an ensemble. */
export interface JudgeRun {
  /** Absent when the run errored (invalid JSON after retry, API failure). */
  verdict?: JudgeVerdict;
  error?: string;
  provider: string;
  model: string;
  cached: boolean;
  usage?: TokenUsage;
  durationMs: number;
}

/** Aggregated outcome of an ensemble of judge runs for one subject. */
export interface ConsensusResult {
  runs: JudgeRun[];
  votes: { pass: number; fail: number; partial: number; error: number };
  /** Majority verdict; `partial` counts as fail for the binary outcome. */
  verdict: Match;
  /** Fraction of non-errored runs agreeing with the majority verdict. */
  agreement: number;
  /** Mean confidence across non-errored runs. */
  meanConfidence: number;
  zone: Zone;
}
