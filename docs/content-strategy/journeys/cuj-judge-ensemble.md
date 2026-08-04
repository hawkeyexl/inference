---
id: cuj-judge-ensemble
code: P1
type: cuj
title: Stand up a judge ensemble with consensus and zones
personas:
  - persona-priya
anchor: true
trigger: A tool author needs a model's opinion to become a decision their CLI can act on
entry_point: /judge/
success_criteria: >
  A working N-run ensemble whose result routes to auto-pass, auto-fail, or human-review by a rule
  the author can defend, with the guarantee understood that an errored run can never produce a
  silent pass.
steps:
  - stage: Understand the decision model
    doc: /judge/
    exists: true
    note: Zone before mechanism. Only a unanimous, high-confidence ensemble auto-resolves; everything else routes to human-review.
  - stage: Run an ensemble
    doc: /judge/
    exists: true
    note: judge() in one call, or runEnsemble plus computeConsensus plus zoneFor when the intermediate runs are needed. Sample is examples/judge-ensemble.mjs.
  - stage: Read the consensus
    doc: /judge/
    exists: true
    note: votes, verdict, agreement, meanConfidence, zone. partial counts toward fail but stays visible in the vote breakdown; a tie is not a pass.
  - stage: See an errored run change the outcome
    doc: /judge/
    exists: true
    note: The sample scripts a provider error and shows the result forced to human-review. This is the safety property, demonstrated rather than asserted.
  - stage: Tune the zone thresholds
    doc: /judge/
    exists: true
    note: DEFAULT_ZONES is 0.8 / 0.8. What moving each threshold does, and what it cannot do.
  - stage: Word the verdict schema in your own domain
    doc: /judge/verdict-schema/
    exists: true
    note: P4 depth. Hands off to the schema-override walkthrough.
  - stage: Make repeat runs free
    doc: /judge/caching/
    exists: true
    note: Hands off to P2.
  - stage: Look up the signatures
    doc: /reference/judge/
    exists: true
    note: EnsembleOptions, ConsensusResult, JudgeRun, JudgeVerdict, ZoneThresholds, VERDICT_SCHEMA.
---

**The anchor CUJ.** The lead persona's first and defining journey, and the one every other judge-layer
page assumes has been completed.

Scoped to producing a defensible decision from N runs. Caching is
[`cuj-cache-repeat-runs`](cuj-cache-repeat-runs.md), budgets are
[`cuj-budget-judge-spend`](cuj-budget-judge-spend.md), and schema wording is
[`cuj-custom-verdict-schema`](cuj-custom-verdict-schema.md).

## Why it anchors the set

Priya is the lead persona, and this journey threads the most surface of any single path: provider,
ensemble, consensus math, confidence zones, and the library's central safety property. It is also
the journey whose failure is most expensive — a judge that silently passes a failing artifact is
worse than no judge.

## Lead with the decision, not the mechanism

The temptation is to explain `runs`, then votes, then agreement, then arrive at `zone`. That is
backwards for this reader. Priya is building a product promise, so the page opens with the promise:

> Only a unanimous, high-confidence ensemble auto-resolves. Anything split, low-confidence, or
> containing an errored run routes to `human-review`.

Then the mechanism that delivers it. `zone` is the output she acts on; `agreement` and
`meanConfidence` are how she explains it to a user afterward.

## The boundaries that must be stated

Priya will build on these, so each needs to be exact rather than approximate:

- `partial` counts toward fail for the binary verdict, but stays visible in `votes`.
- A tie is **not** a pass — `auto-pass` requires zero fail votes and zero partial votes.
- **Any** errored run forces `human-review`, regardless of the other runs' confidence.
- `agreement` and `meanConfidence` are computed over non-errored runs only; all-errored yields
  zero agreement.
- Runs are sequential. Concurrency belongs one level up, across subjects, and the docs should say so
  rather than leaving the reader to wonder whether `runs: 5` is parallel.

## Demonstrated, not asserted

The safety property is the reason this library exists in the shape it does, so the sample proves it:
`examples/judge-ensemble.mjs` scripts one provider error into a three-run ensemble and prints the
resulting `zone`. A reader sees `human-review` come out of an otherwise-passing ensemble.

An assertion in prose is forgettable. A printed result that CI re-checks on every PR is not.
