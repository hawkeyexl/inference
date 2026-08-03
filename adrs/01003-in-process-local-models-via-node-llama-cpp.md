---
status: "accepted"
date: 2026-08-03
decision-makers: [hawkeyexl]
---

# In-process local models via node-llama-cpp, behind an async selector

## Context and Problem Statement

Until now the only local-model path was "stand up an OpenAI-compatible server yourself and point
`baseUrl` at it". The consumer installs and runs Ollama; this library knows nothing about weights.
That leaves every eval run in docevals, dockg, and agentevals paying per token, with no offline
judging out of the box and no reproducible model without an external daemon.

Running GGUF weights in-process solves that, but it drags in three problems the other four
providers do not have: a native module with per-platform binaries, a model reference that may name
weights that do not exist on disk yet, and a "pick something sensible for this machine" default
that cannot be computed without an `await`.

The requested feature was a `ts-llama-cpp` provider with an `auto` default, keyword tiers, and
user-supplied Hugging Face model references.

## Decision Drivers

- Four repos consume this package from the npm registry. None should pay an install cost or a
  native-toolchain risk for a feature they have not asked for.
- `resolveProviderIdentity` is synchronous and feeds cache keys. Two providers/models must never
  share a cached result — that property is what the consuming eval tools are built on.
- Picking a tier for a machine depends on GPU VRAM, and reading VRAM requires `await getLlama()`.
- No network in tests. Every code path must be exercisable through an injected seam.
- Which weights a tier points at should be changeable without breaking the API.

## Considered Options

- `ts-llama-cpp` as requested
- `node-llama-cpp` as an ordinary dependency
- `node-llama-cpp` as an optional peer dependency behind a dynamic `import()`
- Keep pointing `openai` at Ollama and add nothing

## Decision Outcome

**`ts-llama-cpp` does not exist.** The npm registry 404s it, as do `llama-cpp-ts` and
`node-llama-cpp-ts`. The nearest real package, `llama.cpp-ts`, has 13 weekly downloads and no
grammar support, so it cannot satisfy `(system, user, schema, temperature) -> JSON`. Chosen instead:
**`node-llama-cpp`** (v3.19.1, MIT, ~1.06M weekly downloads), which has first-class
JSON-Schema-to-GBNF grammar, `hf:` URI resolution with a built-in downloader, and prebuilt binaries
for win32-x64, darwin-arm64, and linux-x64.

It is an **optional peer dependency** (`peerDependenciesMeta.optional`), reached through
`await import("node-llama-cpp")` inside the runtime adapter. npm does not auto-install optional
peer dependencies, so consumers that do not want local models get nothing extra; a missing module
surfaces as an `InferenceError` naming the install command. It is also a devDependency here, so
`npm run typecheck` verifies the adapter against the real upstream types.

The floor is `^3.19.0`, not cosmetic: Gemma 4 support landed in node-llama-cpp PR #591, released
2026-07-19. Earlier versions cannot load anything in the catalog.

### The sync/async split

`spec.model` accepts a selector (`auto`, `fast`, `balanced`, `quality`), a curated alias
(`gemma-4-e4b`), or a Hugging Face URI / local path. `DEFAULT_MODELS["llama-cpp"]` is `"auto"`.

Concrete references resolve synchronously and change nothing: `resolveProviderIdentity` and
`makeProvider` work as before, and the native import plus the multi-gigabyte weights load stay lazy
until the first `completeJSON`.

Selectors need the hardware probe, so they get async twins — `resolveProviderIdentityAsync` and
`makeProviderAsync` — which return the **concrete** model the selector resolved to. **The
synchronous forms throw when handed an unresolved selector.** That is the load-bearing part of this
decision. The tempting alternative, returning the literal `"auto"` as cache-key material, would let
a 2.6 GB and a 6.7 GB model share cached verdicts and would make one key mean different things on
different machines. Throwing is loud, and no existing provider reaches the branch.

Keywords are `fast`/`balanced`/`quality` rather than `low`/`high` (low *what*?) or `fast`/`slow`
(nobody selects "slow").

### The catalog

Five entries, all unsloth Gemma 4 QAT builds, all Apache-2.0 and ungated. One family keeps the chat
template identical across tiers. QAT is built for 4-bit deployment, so it beats a stock Q4 quant of
the same model at a smaller file: E4B is 4.22 GB as QAT `UD-Q4_K_XL` versus 4.98 GB as stock
`Q4_K_M`. Gemma 4's IFEval scores — 94.6 / 96.7 / 97.2 across the three tiers — are the benchmark
that actually predicts schema-conforming output.

**Entries pin an exact blob path, never a `:QUANT` tag.** This is forced, not stylistic: the QAT
repos ship no `Q4_K_M` at all, only `UD-Q4_K_XL` and `UD-Q2_K_XL`, so a tag would fail to resolve.
They also carry `mmproj-*.gguf` (the ~1 GB vision projector — Gemma 4 is natively multimodal) and
`mtp-*.gguf` beside the weights, which text-only judging must not download. A pinned path also
cannot silently re-point under a cache key that already claims it.

Arbitrary `hf:` URIs and local paths pass through untouched. The catalog is a vetted default set,
not a whitelist gate; GGUF is data, not executable code.

### Consequences

- Good, because offline judging works with no daemon, no API key, and zero token cost. `pricingFor`
  returns `undefined` for these models, so `costOfUsage` yields `0` — the existing invariant already
  says the right thing about a free model.
- Good, because consumers that ignore local models see no install-size or toolchain change.
- Good, because a cache key always names the weights that actually ran.
- Good, because re-pointing a tier is a catalog change, not an API change.
- Bad, because there are now two ways to build a provider, and a consumer using selectors must
  reach for the async one. Mitigated by the async forms delegating to the sync ones for every other
  provider, so switching wholesale is safe.
- Bad, because a `llama-cpp` spec that reaches old synchronous consumer code throws instead of
  degrading. That is the intended failure: the alternative is silent cache poisoning.
- Bad, because the smallest catalog entry is a 2.19 GB download. Gemma 4 has no sub-gigabyte build,
  and that is the price of staying in one family with these IFEval scores.

### Two behaviors of the grammar that shaped the provider

`node-llama-cpp` never shows the schema to the model under a raw grammar, so `description` fields —
where consumers put the domain wording ADR 01001 preserves for them — would be invisible. The
provider therefore **restates the schema in the system prompt**, the same fix `claude-cli` and the
OpenAI `json_object` fallback already use.

The grammar also constrains shape but not numeric bounds, so a `confidence` of `4.2` is well-formed
JSON that the schema still rejects. No new code: Ajv in `complete.ts` catches it and the existing
retry handles it. Relatedly, `required` is ignored upstream (every key in `properties` is always
emitted) and `additionalProperties` defaults to `false` — both no-ops for `VERDICT_SCHEMA`, both
documented in the README for consumers with optional fields.

Gemma 4 has a thinking mode, and a grammar constrains from token 0, which cuts reasoning off
mid-thought. The provider passes `budgets: { thoughtTokens: 0 }` by default, exposed as
`LlamaCppProviderOptions.thoughtTokens`.

### Model lifecycle

Loading weights costs seconds and gigabytes, and `runEnsemble` issues N sequential calls, so loaded
models live in a module-level map keyed by resolved path and shared across provider instances.
Freeing them is a standalone `disposeLlamaModels()` rather than a `dispose()` on
`InferenceProvider`: adding one to the contract would make all five providers carry a lifecycle only
this one has, and the contract stays deliberately narrow (ADR 01000). A failed load is evicted so a
flaky download does not poison the model for the rest of the process.

### A dedicated models directory, which is what makes clearing safe

Weights download to **`~/.hawkeyexl-inference/models`**, not node-llama-cpp's global
`~/.node-llama-cpp/models` (overridable via `INFERENCE_MODELS_DIR` or
`LlamaCppProviderOptions.modelsDirectory`).

The global directory is shared: node-llama-cpp's own CLI writes there, as does any other tool on
the machine using the library. On the machine this was developed on it already held a 2.19 GB
`Phi-3.5-mini-instruct.Q4_K_S.gguf.ipull` from December 2024 — twenty months older than this work
and downloaded by something else entirely. A `clearLlamaModels()` that swept that directory would
have destroyed it.

The first design defended against this with a narrow default scope that allow-listed catalog blobs.
Owning a directory outright is better: it removes the hazard instead of guarding it, so
`clearLlamaModels()` can simply clear everything and no `scope` option is needed at all. The cost
is that weights already present in the shared directory are re-downloaded once. A per-user (not
per-project) location keeps one copy shared across all four consuming repos.

Three supporting details survive: only `.gguf` and `.gguf.ipull` are ever touched, so a config or
log is safe even if `directory` is pointed somewhere shared; subdirectories are never walked; and
loaded models are disposed first, because weights are memory-mapped while loaded and Windows
refuses to delete an open file. Selective clearing matches by filename suffix (downloads are named
`hf_<user>_<filename>`) rather than equality, so a change to node-llama-cpp's naming does not
silently stop matching, and split models are matched by stem so every `-00001-of-000NN` part goes
together rather than orphaning the tail.

Because the directory is part of a model's on-disk identity, it is also part of the loaded-model
cache key — the same URI under two directories is two files.

### Confirmation

`test/unit/llama-models.test.ts` pins the catalog invariants: every entry is an exact `.gguf` blob
path, never an `mmproj`/`mtp` file, and `tierForBudget` is monotonic in memory.
`test/unit/llama-cpp.test.ts` drives the provider through an injected `LlamaRuntime` — grammar from
the request schema, schema restated in the prompt, `thoughtTokens` default, usage from the token
meter, weights loaded once across calls and instances, a failed load not cached, and an out-of-range
number failing validation. `test/unit/llama-factory.test.ts` asserts the sync forms throw on a
selector and that `makeProviderAsync(spec).modelName()` equals
`resolveProviderIdentityAsync(spec).model` — the cache-key property, directly.
`test/unit/llama-clean.test.ts` runs against a real temp directory and pins the safety properties:
the default directory is this library's and not `.node-llama-cpp`, non-model files survive,
subdirectories are not walked, partials and every split part are removed, and `dryRun` reports
without deleting. `llama-cpp.test.ts` asserts the provider downloads into that directory and that
two directories yield two separately-loaded models. All of it runs with no network, no GPU, and no weights. `test/integration/live-llama.test.ts` covers the real path,
gated on `INFERENCE_LIVE_LLAMA` and skipped by default.

## Pros and Cons of the Options

### `node-llama-cpp` as an optional peer dependency

- Good, because non-users pay nothing and the native-toolchain risk is opt-in.
- Good, because the dynamic import keeps `dist/index.js` free of any native reference (verified:
  the built bundle contains the `import()` call, and the `.d.ts` mentions `node-llama-cpp` only in
  comments, so consumers without it installed still typecheck).
- Bad, because construction of the real runtime is async, which is what forces the two-factory API.
- Bad, because a consumer can install a version outside the peer range and only find out at runtime.

### `node-llama-cpp` as an ordinary dependency

- Good, because a single static import and a synchronous factory would be simpler.
- Bad, because all four consumers would pull a native binary and risk a postinstall CMake build for
  a feature most of them will not use, in a package whose entire dist is ~29 kB.

### Keep pointing `openai` at Ollama

- Good, because it costs nothing and already works.
- Bad, because it needs a separately installed daemon, so it cannot be a default, cannot pull its
  own weights, and gives no reproducible model for CI.
