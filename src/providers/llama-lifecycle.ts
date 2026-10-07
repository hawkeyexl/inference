/**
 * Model lifecycle for the `llama-cpp` provider: get the weights onto disk,
 * say whether they are there, and say whether they would fit — all WITHOUT
 * loading them (ADR 01014).
 *
 * A consumer that wants to warm a machine ahead of time (a CI image, a first
 * run, a `doctor` command) otherwise has to construct a provider and send it
 * a request, which loads gigabytes into memory just to learn the download
 * finished.
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { InferenceError } from "../types.js";
import { defaultLlamaRuntime } from "./llama-cpp.js";
import {
  LLAMA_MODELS,
  MEMORY_HEADROOM,
  aliasForTier,
  blobNameFor,
  defaultLlamaModelsDirectory,
  isLlamaSelector,
  listModelDirectory,
  matchesModelBlob,
  resolveLlamaModelRef,
  tierForBudget,
} from "./llama-models.js";
import {
  importNodeLlamaCpp,
  lockIsHeld,
  nodeLlamaCppStatus,
  withDirLock,
} from "./llama-install.js";
import type { LlamaCppProviderOptions, LlamaRuntime } from "./llama-cpp.js";
import type { RuntimeInstallOptions } from "./llama-install.js";

/** The same three options the provider takes, so one object serves both. */
export interface LlamaModelLifecycleOptions
  extends Pick<LlamaCppProviderOptions, "runtime" | "modelsDirectory" | "gpu"> {
  /**
   * How the runtime is installed when it is absent. Used by `ensureModel`
   * unless `runtime` is injected; an injected runtime owns its availability.
   */
  install?: RuntimeInstallOptions;
}

/** `"ready"`: on disk and loadable. `"downloading"`: someone is fetching it. */
export type LlamaModelState = "ready" | "downloading" | "missing";

export interface EnsureModelResult {
  /** `"downloaded"` when this call fetched it; `"ready"` when it was already there. */
  state: "downloaded" | "ready";
  /** Size on disk, summed over the parts of a split model. */
  bytes: number;
}

export interface FitsResult {
  fits: boolean;
  /** The model's size times the headroom `tierForBudget` also requires. */
  needBytes: number;
  /** The memory the provider would have for weights. */
  freeBytes: number;
}

/**
 * A partial download counts as live while its `.ipull` was touched this
 * recently. node-llama-cpp rewrites it as chunks land, so a quiet one is an
 * interrupted download, not a running one.
 */
const PARTIAL_FRESH_MS = 2 * 60 * 1000;

/** A download is bounded by the network, not by us; this is a runaway guard. */
const DOWNLOAD_WAIT_MS = 2 * 60 * 60 * 1000;
const DOWNLOAD_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Download a model's weights, and the runtime that loads them, without
 * loading either into memory.
 *
 * Accepts what the provider accepts: a catalog alias, a tier or `auto`, an
 * `hf:` URI, or a path to a `.gguf` file. The runtime comes through the same
 * auto-install path the provider uses and obeys `INFERENCE_NO_AUTO_INSTALL`;
 * it is checked first, so a refused install fails before gigabytes move.
 *
 * Concurrent callers, in this process or others, are serialised by a lock in
 * the models directory. A caller that waits on it returns `"ready"` once the
 * file appears. To see progress without waiting, use `modelState`.
 */
export async function ensureModel(
  model: string,
  options: LlamaModelLifecycleOptions = {},
): Promise<EnsureModelResult> {
  const context = contextFor(options);
  const ref = await resolveRef(model, context);
  const local = localFile(ref);
  if (local) return { state: "ready", bytes: local.bytes };

  const blob = blobNameFor(ref);
  const present = (): boolean => modelFiles(context.directory, blob).length > 0;
  if (present()) return { state: "ready", bytes: bytesOf(context.directory, blob) };

  if (!options.runtime) await ensureRuntime(options.install);
  mkdirSync(context.directory, { recursive: true });
  let downloaded = false;
  await withDirLock(
    context.directory,
    async () => {
      // Another process may have finished while we waited for the lock.
      if (present()) return;
      await context.runtime().resolveModelFile(resolveLlamaModelRef(ref), context.directory);
      downloaded = true;
    },
    {
      name: lockName(blob),
      isDone: present,
      what: `download ${blob}`,
      waitMs: DOWNLOAD_WAIT_MS,
      staleMs: DOWNLOAD_STALE_MS,
    },
  );
  return {
    state: downloaded ? "downloaded" : "ready",
    bytes: bytesOf(context.directory, blob),
  };
}

/**
 * Where a model stands, without loading or downloading anything.
 *
 * `"downloading"` means a live process holds the model's download lock, or a
 * `.ipull` partial for it was written in the last two minutes. A lock whose
 * process has died, and a partial gone quiet, are `"missing"`.
 *
 * `auto` reads the runtime's memory budget to pick a tier, which can start the
 * local-model worker; naming a model or a tier does not.
 */
export async function modelState(
  model: string,
  options: LlamaModelLifecycleOptions = {},
): Promise<LlamaModelState> {
  const context = contextFor(options);
  const ref = await resolveRef(model, context);
  if (localFile(ref)) return "ready";

  const blob = blobNameFor(ref);
  if (modelFiles(context.directory, blob).length > 0) return "ready";
  if (lockIsHeld(context.directory, lockName(blob), DOWNLOAD_STALE_MS)) {
    return "downloading";
  }
  const partial = listModelDirectory(context.directory).some(
    (entry) =>
      entry.endsWith(".ipull") &&
      matchesModelBlob(entry, blob) &&
      Date.now() - mtimeOf(join(context.directory, entry)) < PARTIAL_FRESH_MS,
  );
  return partial ? "downloading" : "missing";
}

/**
 * Would the model's weights, with the headroom the provider's own tier choice
 * requires, fit the memory the provider would have for them?
 *
 * Catalog models are sized from the catalog. Any other model is sized from its
 * file, so it must already be downloaded; otherwise this throws.
 */
export async function fits(
  model: string,
  options: LlamaModelLifecycleOptions = {},
): Promise<FitsResult> {
  const context = contextFor(options);
  const ref = await resolveRef(model, context);
  const bytes = sizeOfModel(model, ref, context.directory);
  const needBytes = bytes * MEMORY_HEADROOM;
  const freeBytes = await context.budget();
  return { fits: needBytes <= freeBytes, needBytes, freeBytes };
}

// --- internals ---------------------------------------------------------

interface Context {
  directory: string;
  runtime: () => LlamaRuntime;
  /** One memory probe per call, however many times it is asked for. */
  budget: () => Promise<number>;
}

function contextFor(options: LlamaModelLifecycleOptions): Context {
  let runtime: LlamaRuntime | undefined;
  let budget: Promise<number> | undefined;
  const getRuntime = (): LlamaRuntime =>
    (runtime ??=
      options.runtime ??
      defaultLlamaRuntime(options.gpu !== undefined ? { gpu: options.gpu } : {}));
  return {
    directory: options.modelsDirectory ?? defaultLlamaModelsDirectory(),
    runtime: getRuntime,
    budget: () => (budget ??= getRuntime().getMemoryBudgetBytes()),
  };
}

/** A selector becomes the alias it points at; anything else is validated as is. */
async function resolveRef(model: string, context: Context): Promise<string> {
  if (!isLlamaSelector(model)) {
    resolveLlamaModelRef(model);
    return model;
  }
  return aliasForTier(model === "auto" ? tierForBudget(await context.budget()) : model);
}

/** A reference to a file that is already somewhere on this machine. */
function localFile(ref: string): { bytes: number } | undefined {
  if (LLAMA_MODELS[ref] || /^(hf|huggingface|https?):|^(hf|huggingface)\.co\//i.test(ref)) {
    return undefined;
  }
  try {
    const stats = statSync(ref);
    return stats.isFile() ? { bytes: stats.size } : undefined;
  } catch {
    return undefined;
  }
}

function sizeOfModel(model: string, ref: string, directory: string): number {
  const local = localFile(ref);
  if (local) return local.bytes;
  const uri = resolveLlamaModelRef(ref);
  const entry = LLAMA_MODELS[ref] ?? Object.values(LLAMA_MODELS).find((e) => e.uri === uri);
  if (entry) return entry.sizeBytes;
  const bytes = bytesOf(directory, blobNameFor(ref));
  if (bytes > 0) return bytes;
  throw new InferenceError(
    `Cannot size llama-cpp model "${model}": it is not in the catalog and its file is not ` +
      `downloaded to ${directory}. Call ensureModel first, or name a catalog model ` +
      `(${Object.keys(LLAMA_MODELS).join(", ")}).`,
  );
}

/** Loadable files for a blob: every part of a split model, never a partial. */
function modelFiles(directory: string, blob: string): string[] {
  return listModelDirectory(directory).filter(
    (entry) => !entry.endsWith(".ipull") && matchesModelBlob(entry, blob),
  );
}

function bytesOf(directory: string, blob: string): number {
  return modelFiles(directory, blob).reduce(
    (total, entry) => total + sizeIfPresent(join(directory, entry)),
    0,
  );
}

function sizeIfPresent(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Dot-prefixed and not a `.gguf`, so `clearLlamaModels` never sees it. */
function lockName(blob: string): string {
  return `.download-${blob}.lock`;
}

/**
 * The runtime comes from the same path the provider uses. `nodeLlamaCppStatus`
 * asks without installing, so a refusal is reported before any weights move.
 */
async function ensureRuntime(install: RuntimeInstallOptions | undefined): Promise<void> {
  const status = await nodeLlamaCppStatus(install);
  if (status.state === "present") return;
  if (status.state === "refused") {
    throw new InferenceError(
      `Cannot prepare a llama-cpp model: ${status.reason}. Nothing was downloaded.`,
    );
  }
  await importNodeLlamaCpp(install);
}

