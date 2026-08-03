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
import type { AnthropicProviderOptions } from "./anthropic.js";
import type { OpenAICompatProviderOptions } from "./openai-compat.js";
import type { MockResponse } from "./mock.js";
import type { ExecFn, InferenceProvider } from "./types.js";

export type ProviderName = "anthropic" | "openai" | "claude-cli" | "mock";

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
  /** Test seam for the claude-cli provider. */
  exec?: ExecFn;
  /** Scripted responses for the mock provider; defaults to a single empty object. */
  mockResponses?: MockResponse[];
}

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  "claude-cli": "claude-sonnet-4-5",
  mock: "mock-model",
};

const DEFAULT_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Resolve the provider name and model WITHOUT constructing the provider —
 * cache keys and pricing need the identity, but construction may require an
 * API key that a fully-cached run never uses.
 */
export function resolveProviderIdentity(spec: ProviderSpec): {
  provider: string;
  model: string;
} {
  return {
    provider: spec.provider,
    model: spec.model ?? DEFAULT_MODELS[spec.provider] ?? "unknown",
  };
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
    default:
      throw new InferenceError(
        `Unknown provider "${String(spec.provider)}". Available: ${Object.keys(
          DEFAULT_MODELS,
        ).join(", ")}.`,
      );
  }
}
