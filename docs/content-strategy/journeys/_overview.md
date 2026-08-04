# Critical user journeys — overview

A CUJ is a complete, end-to-end outcome a persona must be able to reach using this library and its
documentation. CUJs are the organizing principle for the IA: each nav track carries one persona's
journeys, and every page is justified by the CUJ it serves.

This file is the index and the coverage matrix. Each journey has its own file. For the readers, see
[`../personas/_overview.md`](../personas/_overview.md); for where each journey lands on the site, see
[`../information_architecture/proposed-ia.md`](../information_architecture/proposed-ia.md).

## The fourteen

| Code | ID | Title | Track |
|---|---|---|---|
| R1 | [`cuj-first-validated-call`](cuj-first-validated-call.md) | Decide if this fits, and make one validated call | Get started |
| R2 | [`cuj-choose-a-provider`](cuj-choose-a-provider.md) | Pick and configure a provider | Get started |
| **P1** | [`cuj-judge-ensemble`](cuj-judge-ensemble.md) | **Stand up a judge ensemble with consensus and zones** | Judge |
| P2 | [`cuj-cache-repeat-runs`](cuj-cache-repeat-runs.md) | Make repeat runs free and deterministic | Judge |
| P3 | [`cuj-budget-judge-spend`](cuj-budget-judge-spend.md) | Keep spend inside a budget | Judge |
| P4 | [`cuj-custom-verdict-schema`](cuj-custom-verdict-schema.md) | Word my own verdict schema | Judge |
| M1 | [`cuj-single-shot-extraction`](cuj-single-shot-extraction.md) | Extract structured data once, and handle failure honestly | Extract |
| M2 | [`cuj-cost-gate-and-degrade`](cuj-cost-gate-and-degrade.md) | Gate a feature on cost and degrade gracefully | Extract |
| M3 | [`cuj-exec-seam`](cuj-exec-seam.md) | Reuse the exec seam for non-LLM subprocesses | Extract |
| O1 | [`cuj-run-locally`](cuj-run-locally.md) | Run entirely locally, zero cost, no API key | Local |
| O2 | [`cuj-choose-a-local-model`](cuj-choose-a-local-model.md) | Choose a model, or let `auto` choose | Local |
| O3 | [`cuj-manage-model-files`](cuj-manage-model-files.md) | Manage model files on disk | Local |
| X1 | [`cuj-test-without-network`](cuj-test-without-network.md) | Test my integration without a network | Keep it working |
| U1 | [`cuj-upgrade-safely`](cuj-upgrade-safely.md) | Upgrade without invalidating my caches | Keep it working |

**P1 is the anchor journey.** It belongs to the lead persona, threads the most surface of any single
path — provider, ensemble, consensus, zones, and the central safety property — and every other
judge-layer page assumes it has been completed.

## Persona → CUJ coverage matrix

● primary · ○ secondary

| | Priya | Marco | Rin | Owen |
|---|:---:|:---:|:---:|:---:|
| **R1** Decide and make one validated call | | | ● | |
| **R2** Pick and configure a provider | ○ | ○ | ● | |
| **P1** Judge ensemble *(anchor)* | ● | | | |
| **P2** Cache repeat runs | ● | ○ | | |
| **P3** Budget judge spend | ● | ○ | | |
| **P4** Custom verdict schema | ● | | | |
| **M1** Single-shot extraction | | ● | | |
| **M2** Cost gate and degrade | ○ | ● | | |
| **M3** Exec seam | | ● | | |
| **O1** Run locally | | | | ● |
| **O2** Choose a local model | | | | ● |
| **O3** Manage model files | | | | ● |
| **X1** Test without a network | ● | ● | ● | ● |
| **U1** Upgrade safely | ● | ● | | ○ |
| **Primary count** | **6** | **5** | **3** | **4** |

Both invariants hold:

- **Every persona has at least one primary CUJ.** Priya 6, Marco 5, Rin 3, Owen 4.
- **Every CUJ has at least one persona**, and every one has a primary.

Rin's three are deliberate. The evaluating-adopter journey is short by design — it ends when the
reader either leaves or joins another track. Coverage depth is not the goal there; speed to a
decision is.

## Cross-cutting journeys

Two journeys belong to no single persona and use non-persona code letters:

- **X1** is completed by all four personas from four different tracks, and is the only CUJ with no
  primary owner. It gets one page rather than four sections because the answer is identical for
  everyone, and four copies would be four places to drift.
- **U1** is completed by the three personas with a populated cache to protect. Rin has no cache yet,
  so it is not in Rin's path.

## Entry-point routes

Every journey names an `entry_point`, and every step names a `doc` route. Routes are
content-relative — `/judge/caching/` means `docs/src/content/docs/judge/caching.mdx` — so they stay
checkable against the file tree regardless of where the site is deployed.

Steps carry `exists: true` when the route resolves to a real file that covers the step,
`exists: partial` when a stub exists but the outcome is not yet covered, and `exists: false` for
content that does not exist at all. Every `partial` and `false` step carries a `[GAP]` note and is
counted in
[`../information_architecture/ia-gap-analysis.md`](../information_architecture/ia-gap-analysis.md).
