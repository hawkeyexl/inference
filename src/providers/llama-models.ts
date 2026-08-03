/**
 * Curated GGUF models for the in-process `llama-cpp` provider, plus the
 * selector-to-model resolution that sits in front of them.
 *
 * Every entry is an unsloth Gemma 4 QAT build. One family keeps the chat
 * template identical across tiers, and QAT (quantization-aware training) is
 * built for 4-bit deployment, so it beats a standard Q4 quant of the same
 * model at a smaller file size (E4B: QAT UD-Q4_K_XL 4.22 GB vs stock
 * Q4_K_M 4.98 GB). Gemma 4's IFEval scores — 94.6 / 96.7 / 97.2 across the
 * three tiers — are what actually predicts schema-conforming output.
 *
 * Entries pin an exact blob path rather than a `:QUANT` tag. That is a hard
 * requirement, not a style preference: the QAT repos ship NO Q4_K_M — only
 * UD-Q4_K_XL and UD-Q2_K_XL — so a tag would fail to resolve outright. They
 * also carry `mmproj-*.gguf` (the ~1 GB vision projector; Gemma 4 is natively
 * multimodal) and `mtp-*.gguf` next to the weights, which text-only judging
 * must not download. A pinned path also cannot silently re-point underneath a
 * cache key that already claims it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { InferenceError } from "../types.js";

/**
 * Where this library downloads weights — its OWN directory, not
 * node-llama-cpp's global `~/.node-llama-cpp/models`.
 *
 * That default is shared: node-llama-cpp's CLI writes there, as does anything
 * else on the machine using it. Owning a directory outright means clearing it
 * can never destroy a model this library did not download, and it keeps one
 * copy shared across every consumer of this package on the machine.
 *
 * `INFERENCE_MODELS_DIR` overrides it — useful for CI or a shared volume.
 */
export function defaultLlamaModelsDirectory(): string {
  return (
    process.env["INFERENCE_MODELS_DIR"] ||
    join(homedir(), ".hawkeyexl-inference", "models")
  );
}

/** Size tiers, smallest first. Order is load-bearing for `tierForBudget`. */
export const LLAMA_TIERS = ["fast", "balanced", "quality"] as const;
export type LlamaTier = (typeof LLAMA_TIERS)[number];

/** Model selectors — resolved against hardware, never used as a cache key. */
export const LLAMA_SELECTORS = ["auto", ...LLAMA_TIERS] as const;
export type LlamaSelector = (typeof LLAMA_SELECTORS)[number];

export interface LlamaModelEntry {
  /** `hf:` URI pinned to one blob, handed to `resolveModelFile` as-is. */
  readonly uri: string;
  /** Size of that blob in bytes, as reported by the Hugging Face API. */
  readonly sizeBytes: number;
  readonly license: string;
  /** Absent for entries that are selectable by alias but not by tier. */
  readonly tier?: LlamaTier;
  /** Human note for `LLAMA_MODELS` readers deciding what to download. */
  readonly notes: string;
}

/**
 * Frozen per entry, not just at the top level.
 *
 * A shallow freeze leaves the entries writable, and this catalog is exported
 * for consumers to read: a stray write to `sizeBytes` silently re-points
 * `tierForBudget` process-wide, and a write to `uri` defeats the pinned-blob
 * invariant the whole catalog exists to hold (ADR 01003).
 */
export const LLAMA_MODELS: Readonly<Record<string, LlamaModelEntry>> =
  deepFreezeEntries({
    "gemma-4-e2b": {
      uri: "hf:unsloth/gemma-4-E2B-it-qat-GGUF/gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf",
      sizeBytes: 2_620_370_976,
      license: "Apache-2.0",
      tier: "fast",
      notes: "IFEval 94.6. Smallest Gemma 4; the floor for this family.",
    },
    "gemma-4-e4b": {
      uri: "hf:unsloth/gemma-4-E4B-it-qat-GGUF/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf",
      sizeBytes: 4_215_695_776,
      license: "Apache-2.0",
      tier: "balanced",
      notes: "IFEval 96.7. The default for most machines.",
    },
    "gemma-4-12b": {
      uri: "hf:unsloth/gemma-4-12B-it-qat-GGUF/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
      sizeBytes: 6_716_356_800,
      license: "Apache-2.0",
      tier: "quality",
      notes: "IFEval 97.2. Dense 12B; wants a GPU or plenty of RAM.",
    },
    "gemma-4-26b-a4b": {
      uri: "hf:unsloth/gemma-4-26B-A4B-it-qat-GGUF/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf",
      sizeBytes: 14_249_047_104,
      license: "Apache-2.0",
      notes:
        "MoE: 25.2B total, 3.8B active — infers near E4B speed if it fits in memory.",
    },
    "gemma-4-e2b-q2": {
      uri: "hf:unsloth/gemma-4-E2B-it-qat-GGUF/gemma-4-E2B-it-qat-UD-Q2_K_XL.gguf",
      sizeBytes: 2_186_186_784,
      license: "Apache-2.0",
      notes: "Q2 build of the fast tier; smallest download, lowest fidelity.",
    },
  });

function deepFreezeEntries<T extends Record<string, object>>(
  catalog: T,
): Readonly<T> {
  for (const entry of Object.values(catalog)) Object.freeze(entry);
  return Object.freeze(catalog);
}

/** The alias backing each tier, used by `auto` and the tier keywords. */
const TIER_ALIAS: Record<LlamaTier, string> = {
  fast: "gemma-4-e2b",
  balanced: "gemma-4-e4b",
  quality: "gemma-4-12b",
};

export function isLlamaSelector(model: string): model is LlamaSelector {
  return (LLAMA_SELECTORS as readonly string[]).includes(model);
}

/**
 * Weights are only part of the cost — the KV cache at a real context length,
 * the OS, and whatever else the machine is doing all want memory too. Requiring
 * several times the file size keeps `auto` from picking a model that technically
 * loads and then thrashes.
 */
const MEMORY_HEADROOM = 3.5;

/**
 * Largest tier whose weights fit the memory budget with headroom. Lands at
 * roughly: >=24 GB -> quality, >=15 GB -> balanced, else fast.
 *
 * Sized off the catalog's recorded bytes rather than parameter counts: Gemma
 * 4's E-series are per-layer-embedding models whose footprint does not track
 * "effective params" (E4B is 4.5B effective but 15 GB at BF16).
 */
export function tierForBudget(budgetBytes: number): LlamaTier {
  let chosen: LlamaTier = "fast";
  for (const tier of LLAMA_TIERS) {
    const entry = LLAMA_MODELS[TIER_ALIAS[tier]]!;
    if (entry.sizeBytes * MEMORY_HEADROOM <= budgetBytes) chosen = tier;
  }
  // Falls back to the smallest tier rather than refusing: a machine too small
  // for `fast` will thrash, but that is the caller's call to make, not ours.
  return chosen;
}

/**
 * Catalog alias backing a tier. Selectors resolve to this rather than to a raw
 * URI so the identity — and therefore the cache key — stays human-readable.
 */
export function aliasForTier(tier: LlamaTier): string {
  return TIER_ALIAS[tier];
}

/** The pinned URI backing a tier keyword. */
export function uriForTier(tier: LlamaTier): string {
  return LLAMA_MODELS[TIER_ALIAS[tier]]!.uri;
}

/**
 * Turn a concrete model reference — a curated alias, an `hf:` URI, or a local
 * path — into something `resolveModelFile` accepts.
 *
 * Selectors are rejected rather than guessed at: they need a hardware probe,
 * which is async, and this runs on the synchronous cache-key path. Resolving
 * one here from RAM alone would emit a key naming a model the provider then
 * did not load.
 */
export function resolveLlamaModelRef(model: string): string {
  if (isLlamaSelector(model)) {
    throw new InferenceError(
      `llama-cpp model "${model}" is a selector and needs a hardware probe to ` +
        `resolve. Use resolveProviderIdentityAsync/makeProviderAsync, or name a ` +
        `concrete model (e.g. "gemma-4-e4b").`,
    );
  }
  const entry = LLAMA_MODELS[model];
  if (entry) return entry.uri;
  if (isModelPathOrUri(model)) return model;
  throw new InferenceError(
    `Unknown llama-cpp model "${model}". Use a selector (${LLAMA_SELECTORS.join(
      ", ",
    )}), a curated alias (${Object.keys(LLAMA_MODELS).join(
      ", ",
    )}), an hf: URI, or a path to a .gguf file.`,
  );
}

/**
 * A bare unknown word is a typo'd alias, not a model — catch it early rather
 * than letting it reach the downloader as a doomed repo name.
 *
 * Accepts exactly what the error message in `resolveLlamaModelRef` promises: a
 * recognised URI scheme, or something that names a `.gguf` file. A bare
 * `user/repo` is deliberately NOT a model reference — it would otherwise slip
 * past this guard and fail deep inside the downloader with a far worse
 * message. Any real path to weights ends in `.gguf`, on every platform.
 */
function isModelPathOrUri(model: string): boolean {
  return (
    /^(hf|huggingface):/i.test(model) ||
    /^https?:\/\//i.test(model) ||
    /^(hf|huggingface)\.co\//i.test(model) ||
    model.endsWith(".gguf")
  );
}
