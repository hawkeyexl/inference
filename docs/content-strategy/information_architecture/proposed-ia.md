# Information architecture & content set

The target structure for `docs/src/content/docs/**`, derived from the CUJs. This file is the spec
every page is written against; what is missing today and why is
[`ia-gap-analysis.md`](ia-gap-analysis.md).

Scoped to the documentation site only. The README, `CLAUDE.md`, and `adrs/` are separate artifacts
with their own audiences, listed under Supporting below but not part of the nav.

## Design principle

**CUJ-first, not content-first.** The structure follows what personas must accomplish, not the
topics that happen to have prose today. Each top-level track maps to one persona's journeys. The
landing page is a router — "what are you building?" — and Reference is a flat lookup shelf that
journeys deep-link into. Reference supports navigation; it does not drive it.

Explicitly **not** Diátaxis. A tutorial/how-to/explanation/reference split would scatter Priya's
anchor journey across four sections and force Marco through judge-layer material to reach completion
answers. Journey sequencing beats document-type sequencing for a library whose two layers are meant
to be separable.

**Frontmatter requirement:** every page in `docs/src/content/docs/**` must have `title` and
`description`. No exceptions.

## Navigation tree

```
Home — "What are you building?" router + a 30-second proof
│
├─ Get started          (Rin)    → R1, R2
│
├─ Judge & consensus    (Priya)  → P1, P2, P3, P4      ★ lead track, anchor journey
│
├─ Structured extraction (Marco) → M1, M2, M3
│
├─ Run models locally   (Owen)   → O1, O2, O3
│
├─ Keep it working      (all)    → X1, U1
│
└─ Reference (lookup shelf)      → Providers · Completion · Judge · Cache ·
                                    Cost · Local models · Exec · Errors & types · Glossary
```

### Directory mapping

| Nav section | Directory |
|---|---|
| Get started | `get-started/` |
| Judge & consensus | `judge/` |
| Structured extraction | `extract/` |
| Run models locally | `local/` |
| Keep it working | `keep-it-working/` |
| Reference | `reference/` |

Sidebar entries are `autogenerate` per directory, so adding a page to a directory adds it to the
nav. The order of the six sections is fixed in `docs/astro.config.mjs`.

## Content set

★ = Phase 1 launch. Every page is justified by the CUJ it serves. 24 pages, 16 at launch.

### Home

| Page | CUJ | ★ | Notes |
|---|---|:--:|---|
| `index.mdx` | R1 | ★ | Router, not a lesson. Value proposition, the non-goals, Node 24+/ESM, and four "what are you building?" doors. |

### Get started (Rin)

| Page | CUJ | ★ | Notes |
|---|---|:--:|---|
| `get-started/index.mdx` | R1 | ★ | Install, then a validated call against `MockProvider` with no key. Happy path and failure branch in one sample. Two layers explained, then routes onward. |
| `get-started/choose-a-provider.mdx` | R2 | ★ | Five-provider table, `ProviderSpec`, credentials, identity-without-construction, per-provider edges. Usage reporting called out as the consequential column. |

### Judge & consensus (Priya — lead track)

| Page | CUJ | ★ | Notes |
|---|---|:--:|---|
| `judge/index.mdx` | P1 | ★ | **Anchor.** Decision before mechanism. Ensemble → consensus → zones, with an errored run demonstrated forcing `human-review`. |
| `judge/caching.mdx` | P2 | ★ | Key composition as the consumer's job. Replay costs nothing. The recheck-on-read pattern three consumers each invented. |
| `judge/cost-and-budgets.mdx` | P3 | ★ | Unknown price is `undefined`; a gate over an unpriced model is **inert**, not satisfied. Overrides, and what is never charged. |
| `judge/verdict-schema.mdx` | P4 | | Phase 2. The `EnsembleOptions.schema` override; descriptions as prompt surface; the runtime-not-compile-time shape hole. |

### Structured extraction (Marco)

| Page | CUJ | ★ | Notes |
|---|---|:--:|---|
| `extract/index.mdx` | M1 | ★ | `completeValidatedJSON`, the retry contract, the `schema`/`validate` split, and the schema-identity memoization trap. No judge-layer vocabulary anywhere on this page. |
| `extract/budgets-and-errors.mdx` | M2 | | Phase 2. Operational vs model failure, `InferenceError` translation, the soft ceiling, degrading rather than failing. |
| `extract/subprocess-seam.mdx` | M3 | | Phase 2. `realExec` as a general-purpose helper; argv not shell; stdin over argv; `env: undefined` unsets; timer-based timeout. |

### Run models locally (Owen)

| Page | CUJ | ★ | Notes |
|---|---|:--:|---|
| `local/index.mdx` | O1 | ★ | Optional peer dependency, `makeProviderAsync` and why the sync form throws, the same contract unchanged, and the inert budget gate. |
| `local/choosing-a-model.mdx` | O2 | ★ | Memory→tier table with the 3.5× headroom rule, the catalog, pinned blob paths, the four grammar behaviors, `thoughtTokens`. |
| `local/managing-model-files.mdx` | O3 | | Phase 2. Where weights live and why the directory is owned; `dryRun` before the destructive form; the safety guarantees. |

### Keep it working (all personas)

| Page | CUJ | ★ | Notes |
|---|---|:--:|---|
| `keep-it-working/testing.mdx` | X1 | ★ | The three seams — `MockProvider`, `ExecFn`, `LlamaRuntime`. Failure paths as the point. Closes by showing how this docset tests itself. |
| `keep-it-working/upgrading.mdx` | U1 | | Phase 2. `JudgeRun` as a file format; what the library can and cannot invalidate; release channels. |

### Reference (lookup shelf — supports every journey)

| Page | CUJ | ★ | Notes |
|---|---|:--:|---|
| `reference/providers.mdx` | R2, X1 | ★ | Every `ProviderSpec` field, the per-provider options interfaces, `DEFAULT_MODELS`, the factories, `MockProvider`, and the schema helpers. |
| `reference/completion.mdx` | M1 | ★ | `completeValidatedJSON`, `CompleteValidatedOptions`, `InferenceRun`, `validatorFor`. |
| `reference/judge.mdx` | P1, P4 | ★ | `judge`, `runEnsemble`, `EnsembleOptions`, `computeConsensus`, `zoneFor`, `ConsensusResult`, `JudgeRun`, `JudgeVerdict`, `VERDICT_SCHEMA`, `DEFAULT_ZONES`, `resetTemperatureWarning`. |
| `reference/cache.mdx` | P2, U1 | ★ | `JsonCache` constructor arity, `buildCacheKey`, `sha256`, and the on-disk file format. |
| `reference/cost.mdx` | P3, M2 | ★ | `PRICE_TABLE` contents, `pricingFor` resolution order, `costOfUsage`, `costOfRuns`, `Pricing`. |
| `reference/local-models.mdx` | O1, O2, O3 | ★ | The catalog, tiers and selectors, `LlamaCppProviderOptions`, `LlamaRuntime`, `clearLlamaModels`, `disposeLlamaModels`. |
| `reference/exec.mdx` | M3 | | Phase 2. `realExec`, `ExecFn`, `ExecOptions`, `ExecResult`, and the two distinct default timeouts. |
| `reference/errors-and-types.mdx` | all | | Phase 2. `InferenceError`, and the complete exported type index. |
| `reference/glossary.mdx` | all | | Phase 2. Provider, run, verdict, consensus, zone, ensemble, selector, tier, seam. |

### Supporting (not in the nav)

| Artifact | Audience | ★ | Notes |
|---|---|:--:|---|
| `README.md` | Rin | ★ | Slimmed to a router: hook, install, one quickstart, provider table, links into the site. Depth moves to pages. |
| `CLAUDE.md` | contributors | ★ | Pointer block into `docs/content-strategy/`, naming the personas and CUJ codes. Points; does not inline. |
| `adrs/01005-*` | contributors | ★ | The three re-litigable trade-offs behind this docset. |
| `examples/*.mjs` | all | ★ | The runnable samples. Rendered into pages by `?raw` import; executed in CI. |

## Source-of-truth mapping

Reference pages must never contradict the source. Cross-read the paired files before writing.

| Reference page | Source files |
|---|---|
| `reference/providers.mdx` | `src/providers/index.ts`, `src/providers/types.ts`, `src/providers/anthropic.ts`, `src/providers/openai-compat.ts`, `src/providers/claude-cli.ts`, `src/providers/mock.ts` |
| `reference/completion.mdx` | `src/complete.ts` |
| `reference/judge.mdx` | `src/judge/ensemble.ts`, `src/judge/consensus.ts`, `src/judge/zones.ts`, `src/judge/types.ts`, `src/judge/verdict-schema.json` |
| `reference/cache.mdx` | `src/cache.ts` |
| `reference/cost.mdx` | `src/cost.ts` |
| `reference/local-models.mdx` | `src/providers/llama-models.ts`, `src/providers/llama-cpp.ts`, `src/providers/llama-clean.ts` |
| `reference/exec.mdx` | `src/exec.ts`, `src/providers/types.ts` |
| `reference/errors-and-types.mdx` | `src/types.ts`, `src/index.ts` |

Two sources are contracts in their own right and outrank prose in the source files:

- **`test/unit/*.test.ts`** pins behavior the types do not express — a corrupt cache entry is a miss,
  a tie is not a pass, an errored run forces `human-review`, a 40,000-character prompt goes over
  stdin. Verify edge-case claims against assertions.
- **`adrs/`** holds the reasoning. Where a Reference page explains *why*, the ADR is the source and
  should be linked rather than paraphrased at length.

## Phased rollout

- **Phase 1 — Launch (★, 16 pages).** Home; both Get started pages; `judge/` index, caching, and
  cost; `extract/` index; `local/` index and model choice; testing; and six Reference pages. This
  covers every ★ journey end to end and every symbol a launch page mentions.
- **Phase 2 — Depth (8 pages).** P4, M2, M3, O3, U1, and the `exec`, `errors-and-types`, and
  `glossary` Reference pages. All eight ship at launch as stubs carrying their CUJ in frontmatter,
  so no journey step points at a 404.
- **Phase 3 — Polish.** A `CONTRIBUTING.md`, cross-persona refinements, and the automated
  export-drift check described in `ia-gap-analysis.md`.

## Journey walk-through test

Before declaring any ★ CUJ complete, follow all of its steps in order and confirm:

1. The persona reaches the stated `success_criteria` without leaving the track, except for
   deliberate Reference lookups.
2. Every runnable sample on the page comes from `examples/*.mjs` via a `?raw` import and is covered
   by a Doc Detective `runCode` step.
3. Every sample runs with no API key, no network, and no GGUF weights.
4. Every page has `title` and `description` frontmatter.
5. Every `exists: true` step resolves to a real file that actually covers the step's outcome.
