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
import { InferenceError } from "./types.js";
import { warnIfUnsupportedNode } from "./runtime.js";
import type {
  InferenceProvider,
  SharedJSONAnswer,
  SharedJSONProvider,
  SharedJSONRequest,
  SharedJSONResponse,
  TokenUsage,
} from "./providers/types.js";

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

const validatorCache = new WeakMap<object, ValidateFunction>();

/** Compile once per schema object identity — Ajv compilation is not cheap. */
export function validatorFor(
  schema: Record<string, unknown>,
): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  // A fresh Ajv per distinct schema object, not one shared instance: Ajv keeps
  // a registry keyed by `$id`, so a caller that rebuilds an equal schema object
  // per call (spreading VERDICT_SCHEMA to override descriptions, say) misses
  // the identity cache above and would hit "schema with key or id ... already
  // exists" on the second compile. Instances are held only by this WeakMap, so
  // they are collected with the schemas that own them.
  const compiled = new Ajv2020({ allErrors: true }).compile(schema);
  validatorCache.set(schema, compiled);
  return compiled;
}

export async function completeValidatedJSON<T = unknown>(
  options: CompleteValidatedOptions,
): Promise<InferenceRun<T>> {
  // The other half of "first use": a consumer that constructs a provider
  // directly never touches `makeProvider`, but everything still funnels here.
  warnIfUnsupportedNode();
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
      lastError = schemaFailure(validate);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ...base, error: lastError, durationMs: Date.now() - start };
}

function schemaFailure(validate: ValidateFunction): string {
  return `Response failed schema validation: ${(validate.errors ?? [])
    .map((e) => `${e.instancePath} ${e.message}`)
    .join("; ")}`;
}

/** Calls in flight at once when a provider has no native shared-prefix path. */
const DEFAULT_SHARED_CONCURRENCY = 8;

function hasSharedPath(provider: InferenceProvider): provider is SharedJSONProvider {
  return typeof (provider as Partial<SharedJSONProvider>).completeJSONShared === "function";
}

/**
 * N schema-validated answers over one shared prefix: item i is answered for
 * the user turn `shared + items[i]`. ADR 01018.
 *
 * The local provider evaluates the prefix once and generates each answer from
 * it. Every other provider gets one `completeValidatedJSON` call per item, at
 * most `concurrency` at a time. Either way a failed item is recorded as an
 * `error` in its place, never dropped and never coerced; the call itself
 * rejects only when nothing can be answered (no model, a host that is gone).
 */
export async function completeJSONShared(
  provider: InferenceProvider,
  req: SharedJSONRequest,
): Promise<SharedJSONResponse> {
  warnIfUnsupportedNode();
  const concurrency = req.concurrency ?? DEFAULT_SHARED_CONCURRENCY;
  if (!(Number.isInteger(concurrency) && concurrency > 0)) {
    throw new InferenceError(
      `completeJSONShared concurrency must be a positive integer, got ${String(concurrency)}.`,
    );
  }
  if (req.items.length === 0) return { answers: [] };
  const validate = validatorFor(req.schema);
  const temperature = req.temperature ?? 0;

  if (hasSharedPath(provider)) {
    // The grammar shapes a local answer but does not check every keyword
    // (bounds, formats), so the native path is validated here like the rest.
    const response = await provider.completeJSONShared({ ...req, temperature });
    return {
      ...response,
      answers: response.answers.map((answer): SharedJSONAnswer =>
        "error" in answer || validate(answer.json)
          ? answer
          : { error: schemaFailure(validate) },
      ),
    };
  }

  const answers: SharedJSONAnswer[] = new Array<SharedJSONAnswer>(req.items.length);
  let usage: TokenUsage | undefined;
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < req.items.length) {
      const i = next++;
      const run = await completeValidatedJSON({
        provider,
        system: req.system,
        user: req.shared + req.items[i]!,
        schema: req.schema,
        temperature,
        validate,
      });
      answers[i] = run.error !== undefined ? { error: run.error } : { json: run.result };
      if (run.usage) {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + run.usage.inputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + run.usage.outputTokens,
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, req.items.length) }, lane),
  );
  return { answers, ...(usage ? { usage } : {}) };
}
