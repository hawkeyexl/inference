---
id: cuj-run-at-scale
code: P5
type: cuj
title: Run a judge across many subjects
personas:
  - persona-priya
  - persona-marco
trigger: The ensemble works for one subject and now has to run over hundreds
entry_point: /judge/at-scale/
success_criteria: >
  The author runs subjects concurrently with a bounded pool, keeps result order, understands that
  concurrency widens the budget bound, and knows that a rate limit arrives as a review queue rather
  than as an error.
steps:
  - stage: Learn where concurrency belongs
    doc: /judge/at-scale/
    exists: true
    note: Runs inside an ensemble are sequential and stay that way. Concurrency belongs across subjects, where the caller controls it. The docset asserted this twice and never showed it.
  - stage: Write the pool
    doc: /judge/at-scale/
    exists: true
    note: A bounded worker pool over an index cursor. Sample is examples/orchestrate-concurrency.mjs. Assign into results by index - a pool loses the input order that Promise.all would have preserved.
  - stage: Fix the budget gate for concurrency
    doc: /judge/at-scale/
    exists: true
    note: The one-call overshoot bound holds only while the loop is sequential. With a pool of K, up to K calls clear the gate before any adds to spent. The sample prints the overshoot rather than asserting it.
  - stage: Know what a 429 becomes
    doc: /judge/at-scale/
    exists: true
    note: A rate limit arrives as an errored run, and an errored run forces human-review. Raising concurrency converts a provider limit into review-queue noise, which is not what it looks like from the outside.
  - stage: Choose an ensemble size
    doc: /judge/at-scale/
    exists: true
    note: What runs N buys and costs. Both existing eval consumers independently defaulted to 3.
  - stage: Cross-check the sequential bound
    doc: /extract/budgets-and-errors/
    exists: true
    note: The sequential statement of the same rule, with the condition now made explicit. The two pages link each other so neither can be read as the whole truth.
  - stage: Look up the signatures
    doc: /reference/judge/
    exists: true
    note: runEnsemble, EnsembleOptions, ConsensusResult.
---

Taking a working single-subject ensemble and running it over a corpus.

Scoped to orchestration above the library. The ensemble itself is
[`cuj-judge-ensemble`](cuj-judge-ensemble.md); wiring the result into a CLI is
[`cuj-wire-into-a-cli`](cuj-wire-into-a-cli.md).

## The gap this closes

The docset states the policy twice — "concurrency belongs one level up, across subjects" — on
`judge/index.mdx` and again in the judge reference. It never showed a reader how, and only one of
the three production consumers actually implemented it.

That consumer hand-rolled a bounded pool over a shared index cursor. No `p-limit`, no
`Promise.all(map())` — `p-limit` appears in none of the three repositories. The detail worth
carrying over is small and easy to get wrong: **assign results by index**, because a worker pool
loses the input ordering that `Promise.all` would have preserved for free.

## The correction it carries

This journey exists partly to fix a contradiction the docset shipped with.

`extract/budgets-and-errors.mdx` promised that gating before each call "bounds the overshoot to one
call." That is true of sequential iteration, not of the gate. The same docset told readers to add
concurrency across subjects. Under a pool of K, K calls can clear the gate before any of them adds
to the running total — the bound is K calls.

Each page now states its own case and links the other. The rule was never wrong; it was stated
without its condition, which is the same thing from a reader's chair.

## The consequence chain nobody states

Three documented facts compose into a fourth that no page mentioned:

1. Raising concurrency raises the request rate against a provider.
2. A 429 is recorded on `run.error` like any other provider failure.
3. Any errored run in an ensemble forces `human-review`.

So a rate limit does not surface as a rate limit. It surfaces as a growing human-review queue, which
reads like model uncertainty rather than an infrastructure limit. A reader tuning concurrency
upward will see their review pile grow and draw exactly the wrong conclusion.
