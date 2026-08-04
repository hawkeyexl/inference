---
status: "accepted"
date: 2026-08-04
decision-makers: [hawkeyexl]
---

# Document failure and orchestration, and gate both against the source

## Context and Problem Statement

The docset shipped covering the library *contract* well. An audit against `src/` and against all
three registry consumers found two clusters it did not cover, and three statements that were wrong.

**Failure had no home.** Of 20 throw sites, two messages appeared verbatim anywhere in the docset
and fifteen had no coverage at all. There was no troubleshooting page, no error reference, no custom
404. Pagefind indexed none of the strings a stuck reader would paste. The sharpest case: the
zero-config path the docs actively promote fails with `No inference provider is available. Tried:`,
and that text appeared nowhere in the built site.

The cause was structural rather than editorial. **No CUJ covered a failed run**, so no page was ever
chartered for one. The docset reasoned about failure at the level of *policy* — operational versus
model, thrown versus recorded — and repeated that policy across five pages while documenting almost
no *instances*.

**Orchestration above the library had no home either.** Every consumer wrote the same code and no
page showed it: concurrency across subjects (asserted twice, never demonstrated), dry-run over paid
calls, cache directory layout, skip-before-spend keys, confidence-gated writes, the status enum and
exit codes, and the boundary of what stays in the consumer's repo.

## Decision 1: a seventh nav track, organised by symptom

**Chosen: add a "When it breaks" track, and organise it by what the reader is *seeing* rather than
by what they are *building*.**

Every other track maps to a persona's goal. This one cannot: a reader whose run just failed does not
yet know which layer they are in. The entry point is a single question — *did it throw, or did it
come back on `run.error`?* — which separates the two failure classes and routes everything else.

**Rejected: a fifth persona.** The stuck reader is not a new person; it is Priya, Marco, Rin, or
Owen mid-failure. That is exactly the cross-cutting shape `X1` (testing) already uses, so the new
journeys `X2` (diagnose) and `X3` (boundary) follow it — all four personas primary, no new audience.
Inventing a persona would have implied a reader the evidence does not show.

**Rejected: folding it under Reference.** The error *reference* is lookup content and does belong on
the shelf, but the diagnosis path is a journey, and the IA principle says the shelf supports
navigation rather than driving it.

### Consequence

Orchestration pages went into the **existing** persona tracks rather than a new section — `P5` under
Judge, `M4` under Extract, `X3` under Keep it working. Only troubleshooting earned a track, because
only troubleshooting has a distinct entry point. Seven sections, 32 pages, 18 CUJs.

## Decision 2: gate the error reference against `src/`

**Chosen: `scripts/check-error-coverage.mjs` fails the build when a `throw` in `src/` has no entry
on the error reference page.**

A hand-written list of 20 messages is a drift magnet, and a *rotted* error reference is worse than
none — a reader who pastes their real message and finds nothing concludes the whole docset is stale.

The matcher extracts literal runs from each throw expression (the parts of template literals outside
`${…}`) and requires that **at least one run of ≥16 characters** appears on the page. That is
deliberately loose:

- Requiring the full message would force the page to reproduce the source's line wrapping.
- Requiring only the longest run breaks when a message is assembled from several concatenated
  templates and the page elides an interpolation as `<M>`.
- An *undocumented* error matches none of its fragments, which is the case that matters.

Two bugs surfaced while building it, both caught by its own negative test: quoted strings inside
template literals were being harvested as message text (`"${String(spec.provider)}"`), and the
original longest-run rule flagged seven false positives.

It runs in `ci.yml`, **not** `docs.yml`. Rewording a `throw` is a `src/` change, and `docs.yml` is
path-filtered to `docs/**` and `examples/**` — it would never fire for the change most likely to
break the page.

## Decision 3: validate anchors, not just routes

`scripts/check-docs-links.mjs` stripped `#fragment` and checked only that the page existed. With
72 anchor deep-links across the set, a renamed heading left every link "working" in the sense that
the page loads, while silently dropping the reader at the top.

It now collects `id=` attributes per built page and validates fragments. Verified by deliberately
breaking one.

## Decision 4: correct three shipped statements

- **The budget bound.** `extract/budgets-and-errors.mdx` promised that gating before each call
  "bounds the overshoot to one call." That is a property of *sequential iteration*, not of the gate,
  and the same docset recommends concurrency across subjects. Under a pool of K, K calls can clear
  the gate before any adds to the total. Each page now states its case and links the other, and
  `examples/orchestrate-concurrency.mjs` measures the difference rather than asserting it: `$0.045`
  sequential against `$0.072` at concurrency 4, three extra ensembles for three extra workers.
- **Node 24 as a "hard requirement."** There is no runtime guard and no `engine-strict`; it is an
  npm `EBADENGINE` warning. Stated as what it is.
- **The ESM claim — which turned out to be right.** An audit reported that "`require()` will not
  work" was false, having tested `require('./dist/index.js')` — a *file path*, which bypasses the
  `exports` map. The real consumer path fails: `require("@hawkeyexl/inference")` raises
  **`ERR_PACKAGE_PATH_NOT_EXPORTED`**, because `exports` declares `types` and `import` and no
  `require` condition. The claim stood; what was missing was the searchable error code and the fact
  that `await import()` from CommonJS *does* work. Correcting the "correction" is recorded here
  because it is the second time in this docset's history that a confident finding came from
  measuring the wrong thing.

## Consequences

- **`reference/errors.mdx` must be updated with any reworded `throw`.** That is enforced, not
  requested.
- **Two findings are code issues and were deliberately left in `src/`**: an unguarded `JSON.parse`
  in `claude-cli.ts` leaks a raw `SyntaxError` into `run.error`, and there is no runtime
  Node-version check. Both are documented as current behavior and spawned separately. A docs change
  that edits `src/` is how a docs change becomes unreviewable.
- **The custom 404 required disabling Starlight's injected route.** Authoring
  `src/content/docs/404.md` makes Astro warn that `/[...slug]` conflicts with the injected `/404`.
  `disable404Route: true` lets the catch-all build it from our entry alone — same output, no
  warning. The build is now warning-free.
