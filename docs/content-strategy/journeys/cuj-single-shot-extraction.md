---
id: cuj-single-shot-extraction
code: M1
type: cuj
title: Extract structured data once, and handle failure honestly
personas:
  - persona-marco
trigger: A deterministic CLI grows one optional feature that needs a model to propose values
entry_point: /extract/
success_criteria: >
  One schema-constrained call returns a validated object or a recorded error, the author splits the
  request schema from the validation schema, and the failure branch leaves the deterministic path
  untouched.
steps:
  - stage: Get the contract
    doc: /extract/
    exists: true
    note: completeValidatedJSON takes a provider, a system and user prompt, a schema, and a temperature. It returns an InferenceRun. It never throws on a model failure.
  - stage: Make the call
    doc: /extract/
    exists: true
    note: Sample is examples/extract-once.mjs, driven by MockProvider. Shows result, usage, provider, model, cached, durationMs.
  - stage: Handle the failure branch
    doc: /extract/
    exists: true
    note: One call plus one retry by default, then a run with error set and result absent. Never a throw, never a coerced value. The same sample prints both outcomes.
  - stage: Split request schema from validation schema
    doc: /extract/
    exists: true
    note: The move that defines this persona. Send a schema narrowed to this document's missing fields; validate against the wider configured set using the validate option.
  - stage: Memoize the schema object
    doc: /extract/
    exists: true
    note: validatorFor caches on schema object identity in a WeakMap. A fresh object per call recompiles Ajv every time. dockg hit this and memoized on the sorted field set.
  - stage: Tune attempts and temperature
    doc: /extract/
    exists: true
    note: attempts defaults to 2, temperature to 0. What raising each does and does not buy.
  - stage: Gate on cost and degrade
    doc: /extract/budgets-and-errors/
    exists: true
    note: Hands off to M2.
  - stage: Look up the signatures
    doc: /reference/completion/
    exists: true
    note: CompleteValidatedOptions, InferenceRun, validatorFor.
---

One schema-constrained call per subject, with a failure mode that cannot contaminate a
deterministic tool's output.

Scoped to the completion layer. Cost gating and error translation are
[`cuj-cost-gate-and-degrade`](cuj-cost-gate-and-degrade.md); the subprocess helper is
[`cuj-exec-seam`](cuj-exec-seam.md). **Nothing on this page mentions ensembles, consensus, or
zones** — Marco must be able to complete this journey without ever learning the judge layer exists.

## The tension the page is really about

Marco is adding a non-deterministic feature to a tool whose value proposition is determinism. Every
decision follows from that: the feature is opt-in, bounded in cost, reproducible when cached, and
above all fails without touching the deterministic path.

So the invariant to lead with is not a feature — it is a promise:

> An errored run is recorded, never dropped and never coerced. `completeValidatedJSON` returns a run
> with `error` set rather than throwing or inventing a result.

He is not looking for a retry-until-success loop. He is looking for a guarantee that a bad response
never silently becomes data in his output.

## Two schemas, one call

The defining move of this persona, and the thing the page must not omit: send the model a schema
narrowed to exactly the fields missing from *this* document, but validate the response against the
wider configured set. `CompleteValidatedOptions.validate` accepts a pre-compiled Ajv validator and
is what makes the split expressible.

dockg's ADR names this as the reason its extraction was possible at all. Any page presenting
`completeValidatedJSON` as taking one schema is incomplete for this reader.

## The performance trap

`validatorFor` caches compiled validators in a `WeakMap` keyed on **schema object identity**, and
creates a fresh Ajv instance per distinct schema object so two equal-but-distinct schemas sharing an
`$id` cannot collide in a shared registry.

That is correct, and it means a schema *builder* invoked per call defeats the cache entirely and
recompiles Ajv once per document. dockg shipped that bug and fixed it by memoizing on the sorted
field set. The behavior is explained today only in a comment inside `src/complete.ts`.

Show the memoized builder in the sample. It is three lines, and it is the difference between one
compile and one per document.
