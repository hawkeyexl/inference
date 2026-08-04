---
id: cuj-first-validated-call
code: R1
type: cuj
title: Decide if this fits, and make one validated call
personas:
  - persona-rin
trigger: A maintainer with an LLM-shaped feature lands on the README or the site index
entry_point: /
success_criteria: >
  Within minutes, the reader either rules the package out on an informed basis, or has run a
  schema-constrained call on their own machine with no API key and seen a validated result.
steps:
  - stage: Orient
    doc: /
    exists: true
    note: Router page. States the narrow contract and the non-goals — no streaming, no multi-turn, no tool loops — so a reader who needs those leaves in thirty seconds.
  - stage: Check the hard filters
    doc: /get-started/
    exists: true
    note: Node 24+ and ESM-only, stated before any code. Three runtime dependencies, one optional peer dependency.
  - stage: Install
    doc: /get-started/
    exists: true
    note: One command. No account, no key.
  - stage: Run a validated call with no key
    doc: /get-started/
    exists: true
    note: MockProvider drives completeValidatedJSON end to end. Sample is examples/first-call.mjs, executed in CI.
  - stage: See the failure branch
    doc: /get-started/
    exists: true
    note: The same sample shows a run with error set and result absent — never a throw, never a coerced value.
  - stage: Understand the two layers
    doc: /get-started/
    exists: true
    note: Completion versus judge, and that the judge layer can be ignored entirely. Routes to the right track.
  - stage: Point at a real provider
    doc: /get-started/choose-a-provider/
    exists: true
    note: Hands off to R2 once the reader has decided to continue.
---

The on-ramp. A maintainer arrives with a problem and no vocabulary, and leaves either informed
enough to rule the package out or holding a working call.

Scoped to first contact through first validated result. Provider selection is
[`cuj-choose-a-provider`](cuj-choose-a-provider.md); everything past that belongs to a persona
track.

## Why this is the highest-stakes journey

It is the only one whose success condition includes **the reader leaving**. A reader who needs
streaming or multi-turn should discover that immediately, because the contract is
`(system, user, schema, temperature) -> JSON` and will not grow. Spending their time before
telling them is the failure mode this journey is designed to prevent.

## The blocker it removes

Rin's evaluation stalls at the first step if the first runnable thing needs an API key. So the
quickstart uses `MockProvider` — exported for exactly this, no network, no account — and the reader
sees a real `InferenceRun` come back before deciding anything.

That ordering is deliberate and non-negotiable for this page: **run first, choose a provider
second.** Provider selection is a genuine decision with real trade-offs, and a reader makes it far
better after having seen the call shape than before.

## What must appear

- The non-goals, on the first screen, without apology.
- Node 24+ and ESM-only, before any code.
- One runnable sample needing nothing but `npm install`.
- The failure branch in the same sample as the happy path. Rin will write it first.
- At least one real signature. The old README's 43-bare-name API list is the specific failure this
  journey exists to correct.

## What must not

Ensembles, consensus, zones, cache keys, or cost. Every one of them is a term Rin has not earned
yet, and each costs a reader who only needs single-shot extraction.
