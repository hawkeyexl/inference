// Inspecting the curated model catalog before triggering a multi-gigabyte download.
// Runs with no API key and no weights — this reads exported data only.

import {
  LLAMA_MODELS,
  LLAMA_SELECTORS,
  LLAMA_TIERS,
  aliasForTier,
  defaultLlamaModelsDirectory,
  isLlamaSelector,
  resolveLlamaModelRef,
  tierForBudget,
  uriForTier,
} from "@hawkeyexl/inference";

// Decimal GB, matching how the catalog and the library's own download notice report sizes.
const GB = 1_000_000_000;

console.log("selectors:", LLAMA_SELECTORS);
console.log("tiers:", LLAMA_TIERS);
console.log("weights live in:", defaultLlamaModelsDirectory());

console.log("\ncatalog:");
for (const [alias, entry] of Object.entries(LLAMA_MODELS)) {
  const size = (entry.sizeBytes / GB).toFixed(2).padStart(5);
  console.log(`  ${alias.padEnd(16)} ${size} GB  ${entry.license}  tier=${entry.tier ?? "-"}`);
}

// What `auto` would pick on a given machine. The budget is the larger of free GPU
// VRAM and half of system RAM; a model needs 3.5x its file size in that budget.
console.log("\nwhat auto picks:");
for (const gb of [6, 8, 16, 24, 32]) {
  const tier = tierForBudget(gb * GB);
  console.log(`  ${String(gb).padStart(2)} GB budget -> ${tier.padEnd(8)} -> ${aliasForTier(tier)}`);
}

console.log("\nselector check:", isLlamaSelector("auto"), isLlamaSelector("gemma-4-e2b"));

// Aliases expand to an exact blob path, never a :QUANT tag, so a model cannot
// silently re-point underneath a cache key that already names it.
console.log("\nquality tier resolves to:");
console.log(" ", uriForTier("quality"));
console.log("alias resolves to:");
console.log(" ", resolveLlamaModelRef("gemma-4-e2b"));
