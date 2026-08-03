/**
 * Reclaiming disk space from downloaded GGUF weights.
 *
 * This is straightforward because the models directory belongs to this library
 * alone (see `defaultLlamaModelsDirectory`). node-llama-cpp's own global
 * directory is shared with its CLI and anything else on the machine, so
 * clearing THAT would destroy models this library never downloaded; owning a
 * directory removes the hazard rather than defending against it.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  defaultLlamaModelsDirectory,
  resolveLlamaModelRef,
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
  for (const entry of listFiles(directory)) {
    // Only ever weights — a stray config or log in this directory is safe, and
    // so is anything else if `directory` was pointed somewhere shared.
    if (!isModelBlob(entry)) continue;
    if (wanted && !wanted.some((name) => matchesModel(entry, name))) continue;
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

/**
 * The catalog's pinned filename for a model reference.
 *
 * Strips a `#branch` fragment (node-llama-cpp accepts
 * `hf:user/repo/file.gguf#branch`) and splits on both separators, so a Windows
 * path resolves too. Getting either wrong makes a selective clear silently
 * match nothing and report freeing zero bytes.
 */
function blobNameFor(model: string): string {
  const ref = resolveLlamaModelRef(model).split("#")[0]!;
  return ref.split(/[/\\]/).pop()!;
}

function isModelBlob(entry: string): boolean {
  return entry.endsWith(".gguf") || entry.endsWith(".gguf.ipull");
}

/**
 * node-llama-cpp prefixes downloads with `hf_<user>_`, so match by SUFFIX
 * rather than equality — that survives a change to their naming scheme.
 */
function matchesModel(entry: string, blobName: string): boolean {
  const base = entry.replace(/\.ipull$/, "");
  if (base.endsWith(blobName)) return true;
  // Split models land as `<stem>-00001-of-00003.gguf`; every part belongs to
  // the same model, so matching the stem removes the whole set.
  const stem = blobName.replace(/\.gguf$/, "");
  return new RegExp(`${escapeRegExp(stem)}-\\d{5}-of-\\d{5}\\.gguf$`).test(base);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Top level only — a nested directory is not ours to walk. */
function listFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    // No directory means nothing was ever downloaded — not an error.
    return [];
  }
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
