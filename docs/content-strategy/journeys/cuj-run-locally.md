---
id: cuj-run-locally
code: O1
type: cuj
title: Run entirely locally, zero cost, no API key
personas:
  - persona-owen
trigger: The environment cannot hold an API key — CI without secrets, an air-gapped network, or an unfunded laptop
entry_point: /local/
success_criteria: >
  The same pipeline runs with no credential and no per-token cost, using GGUF weights in-process,
  and the operator understands that any budget gate is now inert rather than satisfied.
steps:
  - stage: Understand what local buys and costs
    doc: /local/
    exists: true
    note: No daemon, no key, no per-token cost. In exchange - a multi-gigabyte download, memory pressure, and four schema behaviors that change.
  - stage: Install the optional peer dependency
    doc: /local/
    exists: true
    note: node-llama-cpp is an optional peer dependency and is not installed unless asked. The ^3.19.0 floor is load-bearing — Gemma 4 support landed there.
  - stage: Construct with the async factory
    doc: /local/
    exists: true
    note: makeProviderAsync, not makeProvider. The sync form throws on an unresolved selector rather than recording "auto" as cache-key material. This is the first error most operators hit.
  - stage: Run the same call
    doc: /local/
    exists: true
    note: The provider satisfies the same InferenceProvider contract, so completion and judge code is unchanged. Sample is examples/local-provider.mjs, which uses an injected runtime so CI needs no weights.
  - stage: Recognise the inert budget gate
    doc: /local/
    exists: true
    note: No price-table entry means pricingFor returns undefined and costOfRuns yields 0. Costs zero is not the same as cannot be priced.
  - stage: Learn what changes under a grammar
    doc: /local/choosing-a-model/
    exists: true
    note: required ignored, additionalProperties false, numeric bounds unenforced, descriptions invisible and restated in the prompt, thinking disabled by default.
  - stage: Pick a model
    doc: /local/choosing-a-model/
    exists: true
    note: Hands off to O2.
  - stage: Look up the API
    doc: /reference/local-models/
    exists: true
    note: LlamaCppProviderOptions, LlamaRuntime, the catalog, and the selector helpers.
---

Removing the credential dependency without changing what the tool does.

Scoped to getting a local run working. Model selection is
[`cuj-choose-a-local-model`](cuj-choose-a-local-model.md); disk management is
[`cuj-manage-model-files`](cuj-manage-model-files.md).

## Frame it as substitution, not shopping

Owen is not choosing a model family. He wants the same pipeline, the same verdicts, the same schema,
minus the key. Content organized around model architectures answers a question he did not ask.

So the page's spine is: *what stays the same* (the `InferenceProvider` contract, so every line of
completion and judge code is untouched), then *what you must do differently* (one install, one
factory change), then *what silently behaves differently* (the schema caveats and the inert budget
gate).

## The first error, and why it is correct

`makeProvider({ provider: "llama-cpp" })` throws. The default model is the selector `auto`, and
resolving it reads GPU memory, which needs an `await`.

The refusal is deliberate: recording the literal `"auto"` as cache-key material would let a 2.6 GB
and a 6.7 GB model share cached results, and make one key mean different things on two machines.
`makeProviderAsync` and `resolveProviderIdentityAsync` return the model the selector actually
resolved to.

Both async forms delegate to the sync ones for every other provider, so a reader can switch over
wholesale rather than branching. Say that — it converts a scary-looking change into a mechanical
one.

## The trap he arrives carrying

Owen usually comes from a budget-gated pipeline. Locally, `pricingFor` returns `undefined` and every
`maxCostUsd` check passes unconditionally. Nothing is broken; the gate is **inert**.

That matters beyond the local run: if he later switches one stage back to a hosted provider whose
model is not in the price table, the gate is *still* inert. The distinction between **costs zero**
and **cannot be priced** needs to be made once, here, clearly.

## Testing without weights

The sample must run in CI on a machine with no GGUF files and no GPU. `LlamaRuntime` is the
injection seam — the same one the library's own unit tests use — so `examples/local-provider.mjs`
drives a fake runtime and demonstrates the full path without a download. The real-weights path is
shown but not executed, and flagged as such.
