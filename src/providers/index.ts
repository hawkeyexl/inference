/**
 * Provider factory over a library-owned `ProviderSpec`.
 *
 * The spec is deliberately NOT any consumer's config type. Every consumer maps
 * its own config into this flat shape, so adding a provider here does not
 * require touching four config schemas, and no consumer has to model its
 * config on another's to reuse this layer (ADR 01000).
 */
import { InferenceError } from "../types.js";
import type { Pricing } from "../cost.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { MockProvider } from "./mock.js";
import { LlamaCppProvider, defaultLlamaRuntime } from "./llama-cpp.js";
import { aliasForTier, isLlamaSelector, tierForBudget } from "./llama-models.js";
import type { AnthropicProviderOptions } from "./anthropic.js";
import type { OpenAICompatProviderOptions } from "./openai-compat.js";
import type { MockResponse } from "./mock.js";
import type { LlamaCppProviderOptions, LlamaRuntime } from "./llama-cpp.js";
import type { LlamaTier } from "./llama-models.js";
import type { ExecFn, InferenceProvider } from "./types.js";

export type ProviderName =
  | "anthropic"
  | "openai"
  | "claude-cli"
  | "mock"
  | "llama-cpp";

export interface ProviderSpec {
  provider: ProviderName;
  /** null/undefined selects the per-provider default. */
  model?: string | null;
  /** Env var NAME holding the API key; null/undefined selects the default. */
  apiKeyEnv?: string | null;
  /** openai only. */
  baseUrl?: string;
  /** claude-cli only: the executable to run. */
  command?: string;
  /** claude-cli only: subprocess timeout. */
  timeoutMs?: number;
  /**
   * Pricing override for this model. Not used to construct the provider —
   * carried here so a consumer passes one object to both `makeProvider` and
   * `pricingFor`.
   */
  pricing?: Pricing;
  /** Provider-specific tuning, ignored by the other providers. */
  anthropic?: AnthropicProviderOptions;
  openai?: OpenAICompatProviderOptions;
  llamaCpp?: LlamaCppProviderOptions;
  /** Test seam for the claude-cli provider. */
  exec?: ExecFn;
  /** Test seam for the llama-cpp provider. */
  llamaRuntime?: LlamaRuntime;
  /** Scripted responses for the mock provider; defaults to a single empty object. */
  mockResponses?: MockResponse[];
}

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  "claude-cli": "claude-sonnet-4-5",
  mock: "mock-model",
  // A selector, not a pinned model: which weights a tier points at is then a
  // catalog change rather than an API change. Resolving it needs the async
  // factory — see `resolveProviderIdentityAsync`.
  "llama-cpp": "auto",
};

const DEFAULT_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface ProviderIdentity {
  provider: string;
  model: string;
}

/**
 * Resolve the provider name and model WITHOUT constructing the provider —
 * cache keys and pricing need the identity, but construction may require an
 * API key that a fully-cached run never uses.
 *
 * Throws for an unresolved `llama-cpp` selector. That is deliberate: picking a
 * tier weighs GPU VRAM, which needs an await, and returning the literal
 * "auto" as cache-key material would let a 2 GB and a 12 GB model share cached
 * verdicts — and give different results per machine under one key. Use
 * `resolveProviderIdentityAsync` for selectors.
 */
export function resolveProviderIdentity(spec: ProviderSpec): ProviderIdentity {
  const model = spec.model ?? DEFAULT_MODELS[spec.provider] ?? "unknown";
  if (spec.provider === "llama-cpp" && isLlamaSelector(model)) {
    throw new InferenceError(
      `llama-cpp model "${model}" is a selector and cannot be resolved ` +
        `synchronously — picking a tier probes GPU memory. Use ` +
        `resolveProviderIdentityAsync/makeProviderAsync, or name a concrete ` +
        `model (e.g. "gemma-4-e4b").`,
    );
  }
  return { provider: spec.provider, model };
}

/**
 * Selector-aware identity resolution. Returns the CONCRETE model a selector
 * resolved to, so the cache key names the weights that actually ran.
 *
 * Every other provider delegates to the synchronous form, so a consumer can
 * switch to this wholesale.
 */
export async function resolveProviderIdentityAsync(
  spec: ProviderSpec,
): Promise<ProviderIdentity> {
  const model = spec.model ?? DEFAULT_MODELS[spec.provider] ?? "unknown";
  if (spec.provider !== "llama-cpp" || !isLlamaSelector(model)) {
    return resolveProviderIdentity(spec);
  }
  const tier: LlamaTier =
    model === "auto" ? await probeTier(llamaRuntimeFor(spec)) : model;
  return { provider: spec.provider, model: aliasForTier(tier) };
}

/**
 * A runtime can be injected either as `spec.llamaRuntime` or inside
 * `spec.llamaCpp` — `makeProvider` honours both, so selector resolution must
 * too. Missing one sends the probe to the real native module and throws for a
 * consumer whose whole point was to avoid it.
 */
function llamaRuntimeFor(spec: ProviderSpec): LlamaRuntime | undefined {
  return spec.llamaRuntime ?? spec.llamaCpp?.runtime;
}

async function probeTier(runtime: LlamaRuntime | undefined): Promise<LlamaTier> {
  const source = runtime ?? defaultLlamaRuntime();
  return tierForBudget(await source.getMemoryBudgetBytes());
}

export function makeProvider(spec: ProviderSpec): InferenceProvider {
  const { model } = resolveProviderIdentity(spec);

  switch (spec.provider) {
    case "anthropic":
      return new AnthropicProvider(
        model,
        spec.apiKeyEnv ?? DEFAULT_API_KEY_ENV["anthropic"]!,
        spec.anthropic ?? {},
      );
    case "openai":
      return new OpenAICompatProvider(
        spec.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
        model,
        spec.apiKeyEnv ?? DEFAULT_API_KEY_ENV["openai"]!,
        undefined,
        spec.openai ?? {},
      );
    case "claude-cli":
      return new ClaudeCliProvider(
        model,
        spec.command ?? "claude",
        spec.exec,
        spec.timeoutMs,
      );
    case "mock":
      // Offline smoke-testing seam: proposes nothing unless scripted.
      return new MockProvider(spec.mockResponses ?? [{ json: {} }], model);
    case "llama-cpp":
      return new LlamaCppProvider(model, {
        ...(spec.llamaCpp ?? {}),
        ...(spec.llamaRuntime ? { runtime: spec.llamaRuntime } : {}),
      });
    default:
      throw new InferenceError(
        `Unknown provider "${String(spec.provider)}". Available: ${Object.keys(
          DEFAULT_MODELS,
        ).join(", ")}.`,
      );
  }
}

/**
 * Selector-aware provider construction. Resolves a `llama-cpp` selector
 * against this machine first, so the returned provider's `modelName()` — and
 * therefore the cache key — names the weights it will actually load.
 *
 * Every other provider delegates to `makeProvider`.
 */
export async function makeProviderAsync(
  spec: ProviderSpec,
): Promise<InferenceProvider> {
  const { model } = await resolveProviderIdentityAsync(spec);
  return makeProvider({ ...spec, model });
}
