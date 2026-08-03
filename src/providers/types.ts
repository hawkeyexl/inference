/**
 * The provider contract. A provider turns a (system, user, schema) request
 * into schema-conforming JSON. `provider()` and `modelName()` feed cache keys
 * and pricing lookups, so two providers/models never share a cached result.
 *
 * This is deliberately the narrowest useful surface: no streaming, no
 * multi-turn, no tool loops. Everything downstream of it — judging,
 * extraction, classification — is schema-constrained single-shot completion.
 */
export interface CompleteJSONRequest {
  system: string;
  user: string;
  /** JSON Schema the response must conform to. */
  schema: Record<string, unknown>;
  temperature: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompleteJSONResponse {
  json: unknown;
  /** Absent when the provider does not report usage (e.g. the Claude CLI). */
  usage?: TokenUsage;
}

export interface InferenceProvider {
  /** Stable provider id — feeds cache keys. */
  provider(): string;
  /** Model id — feeds cache keys and pricing. */
  modelName(): string;
  completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResponse>;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be spawned (e.g. binary not found). */
  spawnError?: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /**
   * Overrides on the ambient environment. A key mapped to `undefined`
   * *unsets* that variable for the child rather than passing it through —
   * Node omits undefined-valued keys when it builds the child's environment.
   * Clearing inherited state (`GIT_*`, say) needs this, so the value type is
   * deliberately wider than `string`.
   */
  env?: Record<string, string | undefined>;
  /** Text piped to the child's stdin (stdin is closed after writing). */
  input?: string;
}

/** Injectable process-execution seam — subprocess providers take one for tests. */
export type ExecFn = (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>;
