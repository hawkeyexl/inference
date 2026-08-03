/**
 * One schema-validated completion, with a single retry.
 *
 * The invariant every consumer depends on: a run that cannot produce
 * schema-valid JSON after the retry is recorded as an ERROR, not dropped and
 * not coerced. Downstream, an errored run counts against consensus — it can
 * push a result toward human review, but it can never produce a silent pass.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { InferenceProvider, TokenUsage } from "./providers/types.js";

/** One attempt at a schema-constrained completion. */
export interface InferenceRun<T = unknown> {
  /** Absent when the run errored (invalid JSON after retry, API failure). */
  result?: T;
  error?: string;
  provider: string;
  model: string;
  cached: boolean;
  usage?: TokenUsage;
  durationMs: number;
}

export interface CompleteValidatedOptions {
  provider: InferenceProvider;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  temperature?: number;
  /**
   * Attempts before recording an error. Default 2 (one initial call plus one
   * retry) — matches the behavior all three source projects shipped.
   */
  attempts?: number;
  /**
   * Pre-compiled validator. Compiling Ajv per call is wasteful in an ensemble
   * loop, so `runEnsemble` compiles once and passes it down.
   */
  validate?: ValidateFunction;
}

const ajv = new Ajv2020({ allErrors: true });
const validatorCache = new WeakMap<object, ValidateFunction>();

/** Compile once per schema object identity — Ajv compilation is not cheap. */
export function validatorFor(
  schema: Record<string, unknown>,
): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const compiled = ajv.compile(schema);
  validatorCache.set(schema, compiled);
  return compiled;
}

export async function completeValidatedJSON<T = unknown>(
  options: CompleteValidatedOptions,
): Promise<InferenceRun<T>> {
  const {
    provider,
    system,
    user,
    schema,
    temperature = 0,
    attempts = 2,
  } = options;
  const validate = options.validate ?? validatorFor(schema);

  const start = Date.now();
  const base = {
    provider: provider.provider(),
    model: provider.modelName(),
    cached: false,
  };

  let lastError = "unknown error";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await provider.completeJSON({
        system,
        user,
        schema,
        temperature,
      });
      if (validate(response.json)) {
        return {
          ...base,
          result: response.json as T,
          usage: response.usage,
          durationMs: Date.now() - start,
        };
      }
      lastError = `Response failed schema validation: ${(validate.errors ?? [])
        .map((e) => `${e.instancePath} ${e.message}`)
        .join("; ")}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ...base, error: lastError, durationMs: Date.now() - start };
}
