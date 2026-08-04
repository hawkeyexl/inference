# IA gap analysis

What documentation exists today, where each piece lands in the proposed structure, and everything
the CUJs require that does not exist. The target structure is
[`proposed-ia.md`](proposed-ia.md).

**Surfacing the gaps is the deliverable.** This docset is being built from scratch, so almost
everything below is a gap by construction. The value is in which gaps are *load-bearing* — the ones
with evidence that a real consumer already paid for them.

## What exists today

| Artifact | Size | Character |
|---|---|---|
| `README.md` | 381 lines | Dense and accurate, but a narrative. One long scroll, no journeys, no signatures. |
| `adrs/01000`–`01004` | 5 ADRs | The reasoning behind every major decision. Excellent, and invisible to anyone who does not open the directory. |
| `CLAUDE.md` | 110 lines | Seven invariants and the consumer-compatibility rules. Written for contributors, read by nobody else. |
| Source JSDoc | throughout `src/` | Several behaviors documented only here. |

No documentation site. No page has ever existed.

## Current README → proposed structure

Every section of the README has a destination. Nothing is discarded.

| README section | Destination | Change |
|---|---|---|
| Title + provenance blurb | `index.mdx`, slimmed `README.md` | Kept; provenance shortened to one line |
| Install | `get-started/index.mdx` | Node 24+/ESM promoted above the fold |
| What it does (two layers) | `index.mdx` + `get-started/index.mdx` | Becomes the router's core, then the two-layer explanation |
| Quick start → completion | `get-started/index.mdx`, `extract/index.mdx` | Rewritten to `MockProvider` so it runs key-free; failure branch added |
| Quick start → judge | `judge/index.mdx` | Reordered decision-first; errored-run demonstration added |
| Quick start → caching | `judge/caching.mdx` | Expanded with the recheck-on-read pattern |
| Quick start → cost | `judge/cost-and-budgets.mdx` | Expanded with the inert-gate warning |
| Providers table + `ProviderSpec` | `get-started/choose-a-provider.mdx` + `reference/providers.mdx` | Split: decision content vs. lookup content |
| Auto-detection | `get-started/choose-a-provider.mdx` + `reference/providers.mdx` | Promoted to the top of the page — it is the zero-config path and the best answer for a reader with no credential |
| Local models (all subsections) | `local/*.mdx` + `reference/local-models.mdx` | Split across three journey pages and one reference page |
| Testing against this library | `keep-it-working/testing.mdx` | Expanded from `MockProvider` alone to all three seams |
| **API (52 bare names)** | **all nine Reference pages** | **Replaced with real signatures.** The single biggest change |
| Design decisions (ADR links) | `index.mdx` footer + inline links | Linked from the pages whose reasoning they carry |
| License | slimmed `README.md` | Unchanged |

## Gaps with evidence

Ranked by evidence strength. Every item cites a consumer's ADR, source comment, or shipped
workaround — none are inferred.

### 1. The verdict-schema override is undiscoverable · P4

`EnsembleOptions.schema` is the seam **both** existing judge consumers depend on. It appears in
ADR 01001 and in the type definition. It appears **nowhere in the README**.

docevals' and agentevals' schemas differ from the canonical one only in `$id`, `title`, and field
descriptions — and descriptions are prompt surface that measurably steers the model. A reader who
does not open the ADRs cannot discover the capability their use case requires.

*Also missing:* the known hole that a non-`JudgeVerdict`-shaped override fails at runtime, not at
compile time.

### 2. An unpriced model makes every budget gate inert · P3, O1, R2

agentevals ships `pricingOverrideFor()` threaded through both its judge and fill paths, and states
the problem in its ADR: a model the built-in table does not know prices at 0, which silently
disables every `maxCostUsd` budget.

The library's behavior is correct — unknown is never a guess. The **consequence** is documented
nowhere. Three separate readers reach it by three roads: an unknown hosted model, `claude-cli`
reporting no usage at all, and any local model.

*Fix:* state **costs zero** versus **cannot be priced** as a distinction, on all three pages.

### 3. The validator cache is keyed on schema object identity · M1

dockg built a fresh schema object per call and recompiled Ajv once per document before discovering
this, then memoized `proposalSchema` on the sorted field set. Explained today only in a comment
inside `src/complete.ts`.

### 4. The recheck-on-read cache wrapper, invented three times · P2, U1

docevals, dockg, and agentevals each independently wrapped `JsonCache` to re-validate entries on
read, because the library deliberately does not know what shape any consumer stores. Three
independent inventions of one pattern is a documentation gap by definition.

### 5. Identity-without-construction, invented three times · R2

All three consumers rediscovered `resolveProviderIdentity` and each wrote its own lazy
`getProvider()` thunk so a fully-cached run needs no API key. The function is exported and mentioned
in the README; the **pattern** is not.

### 6. `InferenceError` must be translated, invented three times · M2

docevals → `DocevalsError`, agentevals → `AgentevalsError`, dockg → `DockgError`. Each host CLI maps
only its own error class to an exit code, so an untranslated `InferenceError` turns a fixable config
mistake into an unhandled stack trace. Six lines, written three times.

### 7. A retried request under-reports cost · M2, P3

`InferenceRun` carries only the successful attempt's usage, so a failed first attempt's input tokens
never reach the budget gate. dockg recorded this as a known limitation. Anyone trusting the number
deserves to know their ceiling is soft.

### 8. The exec seam is a general-purpose helper · M3

dockg imports `realExec` and `ExecFn` to drive `git log` — nothing to do with inference. The one
upstream type fix the extraction required (`ExecOptions.env` accepting `undefined` to *unset* an
inherited variable) came from that use. The seam is exported, tested, cross-platform, and presented
nowhere as usable on its own.

### 9. `resetTemperatureWarning` is exported and undocumented · X1

Present in the barrel, absent from the README entirely. It exists for test isolation, which makes
`keep-it-working/testing.mdx` its home.

### 10. No exported symbol has a documented signature · all Reference pages

The README names all 52 value exports (`resetTemperatureWarning` is the sole omission) but gives
**no signature, parameter list, or return value for any of them**. A reader cannot learn
`JsonCache`'s constructor arity, what `EnsembleOptions` accepts, or what `InferenceRun`'s fields
mean without opening `dist/index.d.ts` or the source.

This is the largest gap by volume, and it is what the nine Reference pages exist to close.

### 11. Auto-detection was added after this strategy was first drafted · R2

`detectProvider`, `availableProviders`, `DETECTION_ORDER`, `resetProviderDetectionWarning`, and
`resetClaudeCliProbe` landed on `main` while this docset was being written, and the README documents
them well. They are recorded here because they change the shape of R2: the reader's first option is
now **not choosing at all**, which is also the best answer for anyone without a credential.

Two properties are worth carrying into the docset rather than leaving in the README's prose: that
`mock` is deliberately excluded from detection (an unscripted `{}` would pass as a real result), and
that `availableProviders()` runs every probe including the ~850 ms llama binding load.

## Knowledge that exists only in ADRs

Recovered into the docset rather than left behind. Pages link the ADR for full reasoning.

| Knowledge | ADR | Lands in |
|---|---|---|
| Why `ProviderSpec` is library-owned and flat | 01000 | `get-started/choose-a-provider.mdx` |
| Why `pricing` rides on the spec | 01000 | `judge/cost-and-budgets.mdx` |
| Descriptions are prompt surface | 01001 | `judge/verdict-schema.mdx` |
| `JudgeRun.verdict` vs `InferenceRun.result`, mapped at the boundary | 01001 | `reference/judge.mdx` |
| The override-shape hole is runtime, not compile time | 01001 | `judge/verdict-schema.mdx` |
| `pricingFor` takes the **longest** matching prefix | 01002 | `reference/cost.mdx` |
| The `^3.19.0` floor is load-bearing (Gemma 4 support) | 01003 | `local/index.mdx` |
| The 3.5× memory headroom multiplier | 01003 | `local/choosing-a-model.mdx` |
| Why the models directory is owned, not shared | 01003 | `local/managing-model-files.mdx` |
| Why the catalog pins exact blob paths | 01003 | `local/choosing-a-model.mdx` |

## Knowledge that exists only in `CLAUDE.md`

Written for contributors, load-bearing for consumers.

| Invariant | Lands in |
|---|---|
| An errored run is recorded, never dropped and never coerced | `judge/index.mdx`, `extract/index.mdx` |
| The cache is an optimization, never a dependency | `judge/caching.mdx` |
| Unknown price is `undefined`, unknown cost is `0` | `judge/cost-and-budgets.mdx` |
| Consumers own their prompts and their cache keys | `judge/caching.mdx` |
| The provider contract is deliberately narrow | `index.mdx` |
| **`JudgeRun` is a file format persisted to consumers' caches** | `keep-it-working/upgrading.mdx` |

The last one is the most serious. It is stated in this repo's own `CLAUDE.md` and enforced with a
`BREAKING CHANGE:` footer — but the people whose caches would evaporate have never been told.

## Knowledge that exists only in source JSDoc

| Behavior | Source | Lands in |
|---|---|---|
| `validatorFor` WeakMap identity + fresh Ajv per schema | `src/complete.ts` | `extract/index.mdx` |
| `buildCacheKey` length-prefixing prevents collisions | `src/cache.ts` | `judge/caching.mdx` |
| Cache file format: `<dir>/<key>.json`, 2-space JSON | `src/cache.ts` | `reference/cache.mdx` |
| Timeout settles on the timer, not on `close` | `src/exec.ts` | `extract/subprocess-seam.mdx` |
| `attempts` defaults to 2 (one call + one retry) | `src/complete.ts` | `extract/index.mdx` |
| Anthropic `max_tokens` early guard | `src/providers/anthropic.ts` | `reference/providers.mdx` |
| The opaque `HTTP 400` fallback trigger | `src/providers/openai-compat.ts` | `reference/providers.mdx` |
| Why `disposeLlamaModels` is a free function | `src/providers/llama-cpp.ts` | `reference/local-models.mdx` |

## Pages that map to no CUJ

None. The IA was built CUJ-first, so no page exists without a journey to justify it. This section
stays as a standing check: **if a future page cannot name its CUJ, it does not belong in the nav.**

## Status

All 24 pages are written and all 14 CUJs are walkable end to end. Every CUJ step is `exists: true`,
and `scripts/check-strategy-anchors.mjs` fails the build if one of those routes stops resolving or
starts pointing at a stub.

## Known limitations

Stated rather than hidden.

- **Export coverage is a presence check only.** `scripts/check-docs-exports.mjs` fails CI when an
  export appears on no Reference page, but it cannot tell whether the signature documented there is
  correct. Comparing declared signatures against the `.d.ts` is a larger piece of work and is not
  done.
- **Two paths are documented but not executed in CI.** A real hosted-provider call needs a key, and
  a real GGUF run needs weights. Both are shown, both are flagged as unexecuted, and both have a
  `MockProvider`- or `LlamaRuntime`-backed counterpart that *is* executed.
- **No `CONTRIBUTING.md` yet.** Contributor guidance still lives entirely in `CLAUDE.md`.
