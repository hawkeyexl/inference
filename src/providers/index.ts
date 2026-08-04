/**
 * Provider factory over a library-owned `ProviderSpec`.
 *
 * The spec is deliberately NOT any consumer's config type. Every consumer maps
 * its own config into this flat shape, so adding a provider here does not
 * require touching four config schemas, and no consumer has to model its
 * config on another's to reuse this layer (ADR 01000).
 */
import { InferenceError } from "../types.js";
import { warnIfUnsupportedNode } from "../runtime.js";
import type { Pricing } from "../cost.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { MockProvider } from "./mock.js";
import { LlamaCppProvider, defaultLlamaRuntime } from "./llama-cpp.js";
import {
  LLAMA_MODELS,
  aliasForTier,
  defaultLlamaModelsDirectory,
  isLlamaSelector,
  isModelDownloaded,
  tierForBudget,
} from "./llama-models.js";
import { detectProvider, warnPendingDownload } from "./detect.js";
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

/** A concrete provider, or `"auto"` to detect one. */
export type ProviderSelector = ProviderName | "auto";

export interface ProviderSpec {
  /**
   * Omitting this is identical to `"auto"`: the highest-priority provider this
   * machine can actually use is detected, ending at the free local model.
   * Resolving it needs `makeProviderAsync`/`resolveProviderIdentityAsync`.
   */
  provider?: ProviderSelector;
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
  /** Always concrete — never `"auto"`, so it is safe as cache-key material. */
  provider: ProviderName;
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
  if (spec.provider == null || spec.provider === "auto") {
    throw new InferenceError(
      `No provider specified. Detecting one probes the environment, the Claude ` +
        `CLI and the local model runtime, which cannot be done synchronously — ` +
        `use resolveProviderIdentityAsync/makeProviderAsync, or name a provider ` +
        `(${Object.keys(DEFAULT_MODELS).join(", ")}).`,
    );
  }
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
  // Provider first, then the model logic for whichever provider won.
  const provider =
    spec.provider == null || spec.provider === "auto"
      ? await detectProvider(spec)
      : spec.provider;
  const resolved: ProviderSpec = { ...spec, provider };

  const model = spec.model ?? DEFAULT_MODELS[provider] ?? "unknown";
  if (provider !== "llama-cpp" || !isLlamaSelector(model)) {
    return resolveProviderIdentity(resolved);
  }
  const tier: LlamaTier =
    model === "auto" ? await probeTier(llamaRuntimeFor(spec)) : model;
  return { provider, model: aliasForTier(tier) };
}

/**
 * Warn before a multi-gigabyte download, but only once the caller has actually
 * committed to running.
 *
 * Deliberately NOT in `resolveProviderIdentityAsync`: that resolves an identity
 * *without* constructing anything, which is exactly what a fully-cached run
 * does — and such a run downloads nothing, so warning there announces gigabytes
 * that never move.
 */
function warnIfDownloadPending(spec: ProviderSpec, model: string): void {
  const entry = LLAMA_MODELS[model];
  if (!entry) return;
  const directory =
    spec.llamaCpp?.modelsDirectory ?? defaultLlamaModelsDirectory();
  if (!isModelDownloaded(model, directory)) {
    warnPendingDownload(model, entry.sizeBytes);
  }
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
  // First use of the library, for anyone who goes through the factory — before
  // the spec is even validated, so an unsupported Node is named ahead of any
  // error it might be the real cause of.
  warnIfUnsupportedNode();
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
  // Both halves must be threaded through: passing only the model would leave a
  // detected provider as `undefined` and throw in `makeProvider`.
  const { provider, model } = await resolveProviderIdentityAsync(spec);
  if (provider === "llama-cpp") warnIfDownloadPending(spec, model);
  return makeProvider({ ...spec, provider, model });
}
