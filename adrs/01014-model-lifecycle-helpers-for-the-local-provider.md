---
status: "accepted"
date: 2026-10-05
decision-makers: [hawkeyexl]
---

# Add `ensureModel`, `modelState` and `fits` so a consumer can prepare a local model without loading it

## Context and Problem Statement

The only way to get a local model onto disk was to construct a `llama-cpp` provider and send it a
request. That downloads the weights, but it also loads them, which costs seconds and gigabytes of
memory, and it hides when the download finished. A consumer that wants the machine ready before the
first real call has no good move. A CI image build, a first-run step, a `doctor` command and a
tool that asks a person before a 6 GB download all want the same three things. They want the weights
and the runtime fetched, a way to ask where a download stands, and a way to ask whether a model
would fit.

How should the library expose that without loading anything, and without two processes fetching the
same file at once?

## Decision Drivers

- Nothing loads. The helpers must work on a machine that could not hold the model.
- Two runs started together must not both download a multi-gigabyte file into one directory.
- A second caller must be able to either wait for the first or look without waiting.
- The memory test must be the one the provider already applies, so "fits" never disagrees with
  `auto`.
- The auto-install rules, including `INFERENCE_NO_AUTO_INSTALL`, apply unchanged.

## Considered Options

- Construct a provider and send a throwaway request
- A `prefetch` option on the provider
- Three free functions in the library's local-model layer

## Decision Outcome

Chosen option: "Three free functions", because each answers one question, none needs a provider, and
they sit beside `isModelDownloaded` and `clearLlamaModels`, which are already free functions over the
same directory.

### Interface

```ts
function ensureModel(model: string, options?: LlamaModelLifecycleOptions):
  Promise<{ state: "downloaded" | "ready"; bytes: number }>;
function modelState(model: string, options?: LlamaModelLifecycleOptions):
  Promise<"ready" | "downloading" | "missing">;
function fits(model: string, options?: LlamaModelLifecycleOptions):
  Promise<{ fits: boolean; needBytes: number; freeBytes: number }>;

interface LlamaModelLifecycleOptions {
  modelsDirectory?: string;
  gpu?: LlamaGpu;
  runtime?: LlamaRuntime;
  install?: RuntimeInstallOptions;
}
```

`modelsDirectory`, `gpu` and `runtime` are the provider's own options, so one object serves both.
`model` is anything the provider accepts: an alias, a tier keyword or `auto`, an `hf:` URI, or a
`.gguf` path.

### `ensureModel`

It resolves the model, checks the file, and returns `"ready"` when it is already on disk. Otherwise
it ensures the runtime, then downloads the file through `LlamaRuntime.resolveModelFile`, which
fetches without loading.

The runtime goes first. `nodeLlamaCppStatus` asks without installing, so an install that is refused
(`INFERENCE_NO_AUTO_INSTALL`) or a copy that fails to load is reported before any weights move. An
absent runtime is installed through `importNodeLlamaCpp`, the same path the provider uses. An
injected `runtime` skips this step, since it owns its own availability.

### The lock

The download runs under a lock file, `.download-<blob>.lock`, in the models directory. It is the
install lock generalised, not a second copy. `withLock` in `llama-install.ts` became
`withDirLock(directory, fn, { name, isDone, what, waitMs, staleMs })`, and the runtime install calls
it with its own arguments. The behaviours it already had are unchanged: the file is created
exclusively and holds the owner's pid, a waiter polls, and a lock older than `staleMs` is reclaimed.

Two things are new. A waiter ends its wait when `isDone()` turns true, so a second caller returns
`"ready"` once the file appears and never downloads. And a lock whose process is dead is stale at
once, whatever its age. A download can run for hours, so waiting out a long age limit on a crashed
holder would be a long wait for nothing. The install lock gets the same rule. An empty lock, whose
owner has not yet written its pid, counts as live.

The lock name starts with a dot and does not end in `.gguf`, so `clearLlamaModels` never sees it.
The wait is capped at two hours and the age limit is six. Both are runaway guards, since the network
bounds a download.

### `modelState`

It never waits, loads or downloads. `"ready"` means a loadable file is on disk. `"downloading"` means
a live process holds the download lock, or a `.ipull` partial for the model was written in the last
two minutes. node-llama-cpp rewrites the partial as chunks land, so a quiet one is an interrupted
download and reads as `"missing"`. This is how a caller looks without joining the wait.

### `fits`

`needBytes` is the model's size times `MEMORY_HEADROOM`, the 3.5 that `tierForBudget` already uses.
The constant is now exported from `llama-models.ts` and shared, not copied. `freeBytes` comes from
`LlamaRuntime.getMemoryBudgetBytes`, the probe the provider uses: the larger of free VRAM and half of
RAM. A catalog model is sized from the catalog. Any other model is sized from its file on disk, so it
must already be downloaded. Otherwise `fits` throws an `InferenceError`, because a guess would be
confidence the library does not have.

### Consequences

- Good, because a consumer can prepare a machine without loading anything, and can see a download
  from another process.
- Good, because the model lock and the install lock are one implementation.
- Good, because `fits` and `auto` cannot disagree about headroom.
- Neutral, because `auto` in `modelState` reads the memory budget to pick a tier, which can start the
  local-model worker. Naming a model or a tier does not.
- Bad, because `ensureModel` with an injected `runtime` does not check that a runtime is installed.
  That is the seam's contract, and it is what keeps the tests off the network.

### Confirmation

`test/unit/llama-lifecycle.test.ts` runs the lock files, `.ipull` partials, split models, process
liveness and the models directory for real in temp directories, and fakes only the download. It pins
the states, the single download under concurrent callers, the return to `"ready"` when a file appears
under another process's lock, the reclaim of a dead holder's lock, the refusal before download, and
the relation between `fits` and `tierForBudget`. `scripts/check-docs-exports.mjs` and
`scripts/check-error-coverage.mjs` hold the reference pages to the new exports and messages.

### Commit type

`feat`. It adds exports and one new behaviour of the install lock, the reclaim of a dead holder's
lock. Nothing is removed or renamed.

## Pros and Cons of the Options

### Construct a provider and send a throwaway request

- Good, because it needs no new API.
- Bad, because it loads the weights and needs a prompt and a schema to do nothing useful.

### A `prefetch` option on the provider

- Good, because it is next to the other provider options.
- Bad, because a consumer that has not chosen a provider yet, or never builds one, cannot use it.
- Bad, because it still ties the download to a provider's lifetime.

### Three free functions (chosen)

- Good, because they answer exactly the three questions and need no provider.
- Bad, because the surface grows by three names and two option types.
