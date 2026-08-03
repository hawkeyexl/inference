/**
 * The ensemble judge: N independent runs for one subject, each a fresh request
 * with no shared context (eval isolation), aggregated by consensus and routed
 * through confidence zones.
 *
 * Runs within one ensemble stay sequential on purpose — they are meant to be
 * independent samples, and interleaving them buys nothing. Concurrency belongs
 * one level up, across subjects, where the consumer owns the pool.
 */
import { completeValidatedJSON, validatorFor } from "../complete.js";
import type { JsonCache } from "../cache.js";
import type { InferenceProvider } from "../providers/types.js";
import { computeConsensus } from "./consensus.js";
import { DEFAULT_ZONES, zoneFor, type ZoneThresholds } from "./zones.js";
import {
  VERDICT_SCHEMA,
  type ConsensusResult,
  type JudgeRun,
  type JudgeVerdict,
} from "./types.js";

export interface EnsembleOptions {
  provider: InferenceProvider;
  system: string;
  user: string;
  /** Ensemble size; default 3. */
  runs?: number;
  /** Default 0. Nonzero adds noise to verdicts and warns once. */
  temperature?: number;
  /**
   * Verdict schema. Defaults to the canonical one; pass your own to keep
   * domain-specific field descriptions (they measurably steer the model).
   * Must still produce objects matching `JudgeVerdict`.
   */
  schema?: Record<string, unknown>;
  /** Optional result cache. Requires `cacheKey`. */
  cache?: JsonCache<JudgeRun[]>;
  /** Content-addressed key; build it with `buildCacheKey`. */
  cacheKey?: string;
  /** Prefix for warnings, e.g. your tool's name. */
  label?: string;
}

let warnedTemperature = false;

/**
 * Run the ensemble and return every run. Cached ensembles replay identically,
 * with each run flagged `cached: true` so cost accounting skips them.
 */
export async function runEnsemble(
  options: EnsembleOptions,
): Promise<JudgeRun[]> {
  const {
    provider,
    system,
    user,
    runs: runCount = 3,
    temperature = 0,
    schema = VERDICT_SCHEMA,
    cache,
    cacheKey,
    label = "inference",
  } = options;

  if (temperature > 0 && !warnedTemperature) {
    warnedTemperature = true;
    console.warn(
      `${label}: judge temperature is ${temperature} — nonzero temperature adds noise to verdicts; 0 is strongly recommended.`,
    );
  }

  if (cache && cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) return hit.map((r) => ({ ...r, cached: true }));
  }

  // Compile the schema once for the whole ensemble rather than per run.
  const validate = validatorFor(schema);

  const results: JudgeRun[] = [];
  for (let i = 0; i < runCount; i++) {
    const run = await completeValidatedJSON<JudgeVerdict>({
      provider,
      system,
      user,
      schema,
      temperature,
      validate,
    });
    // `result` is the generic name at the completion layer; the judge layer
    // calls it `verdict`, which is what consumers persist in their caches.
    const { result, ...rest } = run;
    results.push(result === undefined ? rest : { ...rest, verdict: result });
  }

  if (cache && cacheKey) cache.set(cacheKey, results);
  return results;
}

/** Run the ensemble and aggregate it into a zoned consensus. */
export async function judge(
  options: EnsembleOptions & { zones?: ZoneThresholds },
): Promise<ConsensusResult> {
  const runs = await runEnsemble(options);
  const base = computeConsensus(runs);
  return { ...base, zone: zoneFor(base, options.zones ?? DEFAULT_ZONES) };
}

/** Test seam: reset the once-per-process temperature warning. */
export function resetTemperatureWarning(): void {
  warnedTemperature = false;
}
