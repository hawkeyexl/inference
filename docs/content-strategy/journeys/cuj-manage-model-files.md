---
id: cuj-manage-model-files
code: O3
type: cuj
title: Manage model files on disk
personas:
  - persona-owen
trigger: Weights have accumulated and disk must be reclaimed, or a CI runner needs a controlled cache location
entry_point: /local/managing-model-files/
success_criteria: >
  The operator knows where weights live, can relocate them, and can delete them safely — including
  on a shared directory — having previewed the deletion first.
steps:
  - stage: Find where weights live
    doc: /local/managing-model-files/
    exists: true
    note: ~/.hawkeyexl-inference/models, this library's own directory — not node-llama-cpp's shared ~/.node-llama-cpp/models. Per-user, so one copy serves every consuming project on the machine.
  - stage: Understand why the directory is owned
    doc: /local/managing-model-files/
    exists: true
    note: The shared default is used by node-llama-cpp's CLI and anything else on the machine. Owning a directory removes the hazard rather than defending against it. ADR 01003 records the near-miss that motivated it.
  - stage: Relocate the directory
    doc: /local/managing-model-files/
    exists: true
    note: INFERENCE_MODELS_DIR for the whole process, or llamaCpp.modelsDirectory per provider. defaultLlamaModelsDirectory() reports the effective value.
  - stage: Preview a deletion
    doc: /local/managing-model-files/
    exists: true
    note: clearLlamaModels({ dryRun: true }) reports files and freedBytes without deleting. Show this before the destructive form.
  - stage: Clear selectively or entirely
    doc: /local/managing-model-files/
    exists: true
    note: By alias, by URI, by URI with a branch fragment, or everything. Split models remove every part; interrupted .ipull partials are removed too.
  - stage: Trust the safety guarantees
    doc: /local/managing-model-files/
    exists: true
    note: Only .gguf and .gguf.ipull are ever touched, top level only, never recursing. Loaded weights are disposed first, since a memory-mapped model cannot be deleted on Windows. A file held open is skipped, not forced.
  - stage: Free memory in a long-lived process
    doc: /local/managing-model-files/
    exists: true
    note: disposeLlamaModels(). Weights load once per process and are shared across providers naming the same model.
  - stage: Look up the signatures
    doc: /reference/local-models/
    exists: true
    note: clearLlamaModels, ClearLlamaModelsOptions, ClearLlamaModelsResult, defaultLlamaModelsDirectory, disposeLlamaModels.
---

Knowing where multi-gigabyte weights live, moving them, and deleting them without destroying
something else's.

Scoped to disk and process lifecycle. Choosing what to download is
[`cuj-choose-a-local-model`](cuj-choose-a-local-model.md).

## The page is asking for trust

Every other page in this set asks the reader to run something. This one asks them to run a
**delete**, over a directory that may contain gigabytes they care about. The guarantees are
therefore the content, not the caveats, and they should appear before the destructive command rather
than after it:

- Only `.gguf` and `.gguf.ipull` files are ever touched.
- Top level only. Subdirectories are never walked.
- Loaded weights are disposed first, because a memory-mapped model cannot be deleted on Windows.
- A file held open is skipped, not forced.
- `dryRun` reports `files` and `freedBytes` and deletes nothing.

Lead with `dryRun`. An operator who previews once will trust the real command; one who is handed the
real command first may never run either.

## Why the library owns a directory

node-llama-cpp's default `~/.node-llama-cpp/models` is shared with its own CLI and anything else on
the machine using it. ADR 01003 records the concrete near-miss: a 2.19 GB partial download from
December 2024, put there by something else entirely, sitting in that shared directory on a dev
machine. A naive clear would have destroyed it.

The first design was an allow-list of catalog blobs. Owning a directory beat guarding a shared one,
because it removes the hazard instead of defending against it. That reasoning is worth ~80 words on
the page: it tells the reader why the tool re-downloads weights they may already have, which
otherwise looks like a bug.

The location is **per-user, not per-project**, so one copy is shared across every consuming
repository on the machine.

## Selective clearing is subtler than it looks

Downloads are prefixed `hf_<user>_`, so matching a requested name to a file on disk is a suffix
match, not equality — plus a stem rule for split models so every `-00001-of-00003.gguf` part goes
together. A `#branch` fragment is stripped, and both `/` and `\` separators are handled.

The reader does not need the algorithm. They need to know that naming an alias removes exactly that
model and all of its parts, and that an unknown name is rejected rather than silently matching
nothing.
