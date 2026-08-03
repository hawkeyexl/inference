/**
 * Reclaiming disk space from downloaded GGUF weights.
 *
 * This is straightforward because the models directory belongs to this library
 * alone (see `defaultLlamaModelsDirectory`). node-llama-cpp's own global
 * directory is shared with its CLI and anything else on the machine, so
 * clearing THAT would destroy models this library never downloaded; owning a
 * directory removes the hazard rather than defending against it.
 */
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  blobNameFor,
  defaultLlamaModelsDirectory,
  listModelDirectory,
  matchesModelBlob,
} from "./llama-models.js";
import { disposeLlamaModels } from "./llama-cpp.js";

export interface ClearedModelFile {
  path: string;
  sizeBytes: number;
}

export interface ClearLlamaModelsResult {
  /** Files removed, or that would be removed under `dryRun`. */
  files: ClearedModelFile[];
  freedBytes: number;
  directory: string;
  dryRun: boolean;
}

export interface ClearLlamaModelsOptions {
  /** Defaults to this library's own models directory. */
  directory?: string;
  /** Clear only these models (alias or `hf:` URI); default clears all. */
  models?: string[];
  /** Report what would be removed without deleting anything. */
  dryRun?: boolean;
}

/**
 * Delete downloaded GGUF weights and interrupted partial downloads.
 *
 * Loaded models are disposed first: on Windows the weights are memory-mapped
 * while loaded, and deleting an open file fails with EBUSY/EPERM.
 */
export async function clearLlamaModels(
  options: ClearLlamaModelsOptions = {},
): Promise<ClearLlamaModelsResult> {
  const directory = options.directory ?? defaultLlamaModelsDirectory();
  const dryRun = options.dryRun ?? false;
  // Resolve BEFORE touching disk so an unknown name fails without having
  // deleted half the set.
  const wanted = options.models?.map(blobNameFor);

  if (!dryRun) await disposeLlamaModels();

  const files: ClearedModelFile[] = [];
  for (const entry of listModelDirectory(directory)) {
    // Only ever weights — a stray config or log in this directory is safe, and
    // so is anything else if `directory` was pointed somewhere shared.
    if (!isModelBlob(entry)) continue;
    if (wanted && !wanted.some((name) => matchesModelBlob(entry, name))) {
      continue;
    }
    const path = join(directory, entry);
    const sizeBytes = sizeOf(path);
    if (sizeBytes === undefined) continue;
    if (!dryRun) {
      try {
        rmSync(path);
      } catch {
        // A file held open by another process is not this call's business to
        // force; report only what actually went away.
        continue;
      }
    }
    files.push({ path, sizeBytes });
  }

  return {
    files,
    freedBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    directory,
    dryRun,
  };
}

function isModelBlob(entry: string): boolean {
  return entry.endsWith(".gguf") || entry.endsWith(".gguf.ipull");
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
