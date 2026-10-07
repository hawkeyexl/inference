/**
 * Curated GGUF models for the in-process `llama-cpp` provider, plus the
 * selector-to-model resolution that sits in front of them.
 *
 * The three tiers were chosen by measurement, not by published benchmark:
 * 26 real documentation pages with their `title` and `description` removed,
 * refilled through this library under a JSON Schema, and scored against the
 * human-written originals. See ADR 01009 for the numbers and the method.
 *
 * Two results from that run shape this catalog:
 *
 * 1. **Quality barely tracks size on schema-constrained extraction.** Every
 *    model between 1.4 GB and 5.5 GB scored within one standard error of the
 *    others. The tiers therefore buy latency and headroom for richer schemas
 *    than that corpus exercises — they do not buy a linear quality gain, and
 *    should not be described as if they do.
 * 2. **Latency stability does not track size either, and matters more.** Two
 *    builds ran away on long pages, generating until they hit a timeout rather
 *    than closing the JSON: Gemma 4 E2B at Q2 (6 of 12 pages unfinished at
 *    120s, one still going at 400s) and Granite 4.1 8B at Q4 (6 of 26 pages
 *    over 20s, three over 115s). Both are excluded from the tiers for that
 *    reason alone. A tier entry has to terminate.
 *
 * That is why the tiers are no longer one family. Chat templates now differ
 * across tiers, which is fine — node-llama-cpp reads the template out of each
 * GGUF — but it does mean a prompt tuned against one tier is not automatically
 * tuned against the next.
 *
 * The superseded Gemma aliases are kept, untiered, because consumers pin them
 * by name; dropping an alias is a hard failure rather than a slower download.
 *
 * Entries pin an exact blob path rather than a `:QUANT` tag. That is a hard
 * requirement, not a style preference, and it holds for every entry:
 *
 * - A tag can be re-pointed upstream, which silently changes the weights
 *   behind a cache key that already names the model. A pinned path cannot.
 *   This reason alone is sufficient, and it applies to all repos.
 * - Most of these repos carry `mmproj-*.gguf` (the ~1 GB vision projector)
 *   and some carry `mtp-*.gguf` beside the weights, which text-only judging
 *   must not download.
 * - On the Gemma QAT repos a tag would not resolve at all: they ship NO
 *   Q4_K_M, only UD-Q4_K_XL and UD-Q2_K_XL.
 *
 * Note the last point is specific to the Gemma QAT repos, which now back only
 * untiered entries. The Qwen3.5 and Granite repos behind the three tiers DO
 * publish Q4_K_M, so a tag would resolve there — and would still be wrong, for
 * the first reason. Do not read "the tag resolves" as "the tag is allowed".
 */
import { readdirSync } from "node:fs";
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
    "granite-4.1-3b-q2": {
      uri: "hf:unsloth/granite-4.1-3b-GGUF/granite-4.1-3b-UD-Q2_K_XL.gguf",
      sizeBytes: 1_414_548_800,
      license: "Apache-2.0",
      tier: "fast",
      notes:
        "Smallest tier and the quickest measured (4.8s/page). Scores level " +
        "with models three times its size on schema-constrained extraction.",
    },
    "qwen3.5-4b": {
      uri: "hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf",
      sizeBytes: 2_912_109_728,
      license: "Apache-2.0",
      notes:
        "The default for most machines. Smaller and faster than the Gemma 4 " +
        "E4B it replaces, at indistinguishable measured quality.",
      tier: "balanced",
    },
    "qwen3.5-9b": {
      uri: "hf:unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-UD-Q4_K_XL.gguf",
      sizeBytes: 5_966_095_584,
      license: "Apache-2.0",
      tier: "quality",
      notes:
        "Best measured of everything tried, and still smaller and faster " +
        "than the Gemma 4 12B it replaces. Wants a GPU or plenty of RAM.",
    },
    // --- Superseded, kept resolvable by name. Untiered: nothing selects these
    // unless a caller asks for one outright.
    "gemma-4-e2b": {
      uri: "hf:unsloth/gemma-4-E2B-it-qat-GGUF/gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf",
      sizeBytes: 2_620_370_976,
      license: "Apache-2.0",
      notes: "IFEval 94.6. Former `fast` tier; sound, but larger than Granite.",
    },
    "gemma-4-e4b": {
      uri: "hf:unsloth/gemma-4-E4B-it-qat-GGUF/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf",
      sizeBytes: 4_215_695_776,
      license: "Apache-2.0",
      notes: "IFEval 96.7. Former `balanced` tier; sound, but larger.",
    },
    "gemma-4-12b": {
      uri: "hf:unsloth/gemma-4-12B-it-qat-GGUF/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
      sizeBytes: 6_716_356_800,
      license: "Apache-2.0",
      notes: "IFEval 97.2. Former `quality` tier. Dense 12B; wants a GPU.",
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
      notes:
        "AVOID. Smallest download, but it does not reliably terminate: 6 of " +
        "12 pages unfinished at 120s, one still running at 400s, and the " +
        "pages that did finish proposed identifiers as prose. Kept only so " +
        "existing pins still resolve.",
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
  fast: "granite-4.1-3b-q2",
  balanced: "qwen3.5-4b",
  quality: "qwen3.5-9b",
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
export const MEMORY_HEADROOM = 3.5;

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
        `concrete model (e.g. "${TIER_ALIAS.balanced}").`,
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
 * The catalog's pinned filename for a model reference.
 *
 * Strips a `#branch` fragment (node-llama-cpp accepts
 * `hf:user/repo/file.gguf#branch`) and splits on both separators, so a Windows
 * path resolves too. Getting either wrong makes callers silently match nothing.
 */
export function blobNameFor(model: string): string {
  const ref = resolveLlamaModelRef(model).split("#")[0]!;
  return ref.split(/[/\\]/).pop()!;
}

/**
 * Does an on-disk entry belong to this model?
 *
 * node-llama-cpp prefixes downloads with `hf_<user>_`, so match by SUFFIX
 * rather than equality — that survives a change to their naming scheme.
 */
export function matchesModelBlob(entry: string, blobName: string): boolean {
  const base = entry.replace(/\.ipull$/, "");
  if (base.endsWith(blobName)) return true;
  // Split models land as `<stem>-00001-of-00003.gguf`; every part belongs to
  // the same model, so matching the stem covers the whole set.
  const stem = blobName.replace(/\.gguf$/, "");
  return new RegExp(`${escapeRegExp(stem)}-\\d{5}-of-\\d{5}\\.gguf$`).test(base);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Are this model's weights already on disk?
 *
 * A `.ipull` partial counts as NOT downloaded: it cannot be loaded, so
 * treating it as present would skip the download warning and then stall on a
 * download anyway.
 */
export function isModelDownloaded(model: string, directory: string): boolean {
  const blobName = blobNameFor(model);
  return listModelDirectory(directory).some(
    (entry) => !entry.endsWith(".ipull") && matchesModelBlob(entry, blobName),
  );
}

/** Top level only — a nested directory is not ours to walk. */
export function listModelDirectory(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    // No directory means nothing was ever downloaded — not an error.
    return [];
  }
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
