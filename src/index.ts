/**
 * Public API for @hawkeyexl/inference.
 *
 * One entry point covers both layers: schema-constrained completion (the
 * provider contract, the four providers, cache, cost, retry) and the
 * LLM-as-judge ensemble built on top of it. Consumers that only need
 * structured extraction ignore the judge exports (ADR 01001).
 */

// Errors
export { InferenceError } from "./types.js";

// Provider contract
export type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  ExecFn,
  ExecOptions,
  ExecResult,
  InferenceProvider,
  TokenUsage,
} from "./providers/types.js";

// Provider factory
export {
  makeProvider,
  makeProviderAsync,
  resolveProviderIdentity,
  resolveProviderIdentityAsync,
  DEFAULT_MODELS,
  DEFAULT_OPENAI_BASE_URL,
} from "./providers/index.js";
export type {
  ProviderIdentity,
  ProviderName,
  ProviderSelector,
  ProviderSpec,
} from "./providers/index.js";
export {
  DETECTION_ORDER,
  availableProviders,
  detectProvider,
  resetClaudeCliProbe,
  resetProviderDetectionWarning,
} from "./providers/detect.js";

// Concrete providers, for consumers that construct them directly
export { AnthropicProvider } from "./providers/anthropic.js";
export type { AnthropicProviderOptions } from "./providers/anthropic.js";
export {
  OpenAICompatProvider,
  extractJson,
  stripNulls,
  toStrictSchema,
} from "./providers/openai-compat.js";
export type { OpenAICompatProviderOptions } from "./providers/openai-compat.js";
export { ClaudeCliProvider } from "./providers/claude-cli.js";
export { MockProvider, mockVerdict } from "./providers/mock.js";
export type { MockResponse } from "./providers/mock.js";

// Local models (llama.cpp). `node-llama-cpp` is an optional peer dependency —
// importing these names does not load it; constructing a provider does.
export {
  LLAMA_MODELS,
  LLAMA_SELECTORS,
  LLAMA_TIERS,
  aliasForTier,
  blobNameFor,
  defaultLlamaModelsDirectory,
  isLlamaSelector,
  isModelDownloaded,
  resolveLlamaModelRef,
  tierForBudget,
  uriForTier,
} from "./providers/llama-models.js";
export type {
  LlamaModelEntry,
  LlamaSelector,
  LlamaTier,
} from "./providers/llama-models.js";
export {
  LlamaCppProvider,
  defaultLlamaRuntime,
  disposeLlamaModels,
} from "./providers/llama-cpp.js";
export type {
  LlamaCppProviderOptions,
  LlamaLoadedModel,
  LlamaPromptOptions,
  LlamaPromptResult,
  LlamaRuntime,
  LlamaSession,
} from "./providers/llama-cpp.js";
export { clearLlamaModels } from "./providers/llama-clean.js";
export type {
  ClearLlamaModelsOptions,
  ClearLlamaModelsResult,
  ClearedModelFile,
} from "./providers/llama-clean.js";

// Process seam
export { realExec } from "./exec.js";

// Completion
export { completeValidatedJSON, validatorFor } from "./complete.js";
export type {
  CompleteValidatedOptions,
  InferenceRun,
} from "./complete.js";

// Cache
export { JsonCache, buildCacheKey, sha256 } from "./cache.js";

// Cost
export { PRICE_TABLE, costOfRuns, costOfUsage, pricingFor } from "./cost.js";
export type { Pricing } from "./cost.js";

// LLM-as-judge
export { VERDICT_SCHEMA } from "./judge/types.js";
export type {
  ConsensusResult,
  JudgeRun,
  JudgeVerdict,
  Match,
  Zone,
} from "./judge/types.js";
export { computeConsensus } from "./judge/consensus.js";
export { DEFAULT_ZONES, zoneFor } from "./judge/zones.js";
export type { ZoneThresholds } from "./judge/zones.js";
export {
  judge,
  resetTemperatureWarning,
  runEnsemble,
} from "./judge/ensemble.js";
export type { EnsembleOptions } from "./judge/ensemble.js";
