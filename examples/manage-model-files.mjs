// Finding, inspecting, and safely clearing local model weights.
// Runs with no API key and no real weights: it operates on a throwaway directory.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  blobNameFor,
  clearLlamaModels,
  defaultLlamaModelsDirectory,
  isModelDownloaded,
} from "@hawkeyexl/inference";

// Weights live in this library's OWN directory, not node-llama-cpp's shared one,
// so clearing can never destroy models something else downloaded.
// Override with INFERENCE_MODELS_DIR, or llamaCpp.modelsDirectory per provider.
console.log("default directory:", defaultLlamaModelsDirectory());

// The on-disk filename an alias resolves to. Downloads are prefixed hf_<user>_.
console.log("blob for gemma-4-e2b:", blobNameFor("gemma-4-e2b"));

// A throwaway directory standing in for a populated models directory.
const directory = mkdtempSync(join(tmpdir(), "inference-models-"));
const fake = (name, bytes) => writeFileSync(join(directory, name), Buffer.alloc(bytes));

fake(`hf_unsloth_${blobNameFor("gemma-4-e2b")}`, 2048);
fake(`hf_unsloth_${blobNameFor("gemma-4-12b")}`, 4096);
fake(`hf_unsloth_${blobNameFor("gemma-4-e4b")}.ipull`, 512); // an interrupted download
fake("notes.txt", 64); // not a model — must survive

console.log("is gemma-4-e2b downloaded:", isModelDownloaded("gemma-4-e2b", directory));
console.log("is gemma-4-e4b downloaded:", isModelDownloaded("gemma-4-e4b", directory));

// Always preview first. dryRun reports and deletes nothing.
const preview = await clearLlamaModels({ directory, dryRun: true });
console.log("would remove:", preview.files.length, "files,", preview.freedBytes, "bytes");
console.log("dryRun deleted nothing:", readdirSync(directory).length === 4);

// Clear one model by alias. Only that model's blobs go.
const one = await clearLlamaModels({ directory, models: ["gemma-4-12b"] });
console.log("removed by alias:", one.files.length, "remaining:", readdirSync(directory).length);

// Clear the rest. Interrupted .ipull partials are removed too.
const rest = await clearLlamaModels({ directory });
console.log("removed the rest:", rest.files.length);

// Only .gguf and .gguf.ipull are ever touched, top level only, never recursing.
console.log("survivors:", readdirSync(directory));

// An unknown name is rejected rather than silently matching nothing.
try {
  await clearLlamaModels({ directory, models: ["not-a-real-model"] });
} catch (error) {
  console.log("unknown model rejected:", error.message.includes("not-a-real-model"));
}

rmSync(directory, { recursive: true, force: true });
