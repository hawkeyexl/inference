---
id: cuj-budget-judge-spend
code: P3
type: cuj
title: Keep spend inside a budget
personas:
  - persona-priya
  - persona-marco
trigger: A user sets a cost ceiling, or a maintainer needs to answer what a full run costs
entry_point: /judge/cost-and-budgets/
success_criteria: >
  The author prices a run correctly, knows which providers and models can be priced at all, and
  understands that a gate over an unpriced model is inert rather than satisfied.
steps:
  - stage: Learn the pricing rule
    doc: /judge/cost-and-budgets/
    exists: true
    note: Unknown model price is undefined; unknown cost is 0. Never a guess — a fabricated price is worse than an absent one when a gate depends on it.
  - stage: Price a run
    doc: /judge/cost-and-budgets/
    exists: true
    note: pricingFor then costOfRuns. Sample is examples/cost-budget.mjs. Prefix matching means a pinned model variant resolves to its family price.
  - stage: Recognise an inert gate
    doc: /judge/cost-and-budgets/
    exists: true
    note: "The central warning. An unpriced model makes every maxCostUsd check pass unconditionally. agentevals carries pricingOverrideFor() for exactly this."
  - stage: Override a price
    doc: /judge/cost-and-budgets/
    exists: true
    note: ProviderSpec.pricing and the pricingFor override argument. One object serves both construction and pricing.
  - stage: Know what is not charged
    doc: /judge/cost-and-budgets/
    exists: true
    note: Cached runs, runs with no usage, and every claude-cli or llama-cpp run. Also that a retried request under-reports, since only the successful attempt's usage is carried.
  - stage: Gate before spending
    doc: /judge/cost-and-budgets/
    exists: true
    note: Check the budget before each ensemble, not after. Both existing judge consumers do this.
  - stage: Look up the price table
    doc: /reference/cost/
    exists: true
    note: PRICE_TABLE contents, pricingFor resolution order, costOfUsage and costOfRuns signatures.
---

Pricing a run correctly, and understanding precisely when the number can be trusted.

Scoped to cost accounting for the judge layer. Marco's per-call gating and degradation path is
[`cuj-cost-gate-and-degrade`](cuj-cost-gate-and-degrade.md); the caching interaction is
[`cuj-cache-repeat-runs`](cuj-cache-repeat-runs.md).

## The rule, and the consequence nobody documents

The rule is simple and correct: **unknown model price is `undefined`, unknown cost is `0`.** The
library never guesses, because a fabricated price is worse than an absent one when a budget gate
depends on it.

The consequence is the part that has actually hurt someone. If a model is not in `PRICE_TABLE` and
no override is supplied, every `maxCostUsd` check evaluates against zero and **passes
unconditionally**. The gate is not satisfied; it is inert.

agentevals carries a `pricingOverrideFor()` helper threaded through both its judge and fill paths
purely to work around this, and its ADR states the problem in as many words. That is the strongest
single piece of evidence in this docset, and this page exists because of it.

State it as a distinction the reader can act on: **costs zero** (a cached replay, a local model) is
not the same as **cannot be priced** (a model absent from the table). One is a fact; the other is a
missing input.

## Resolution order worth knowing

`pricingFor` prefers an explicit override, then an exact match, then the **longest** matching
prefix. Longest rather than first, so a pinned variant like `claude-sonnet-4-5-20250929` resolves to
its family price and a future longer entry is never shadowed by a shorter one.

## What is not charged

- Cached runs. `costOfRuns` skips anything flagged `cached`.
- Runs with no `usage`. `claude-cli` reports none at all.
- Local models. There is no table entry, by design.
- **The failed attempt of a retried request.** `InferenceRun` carries only the successful attempt's
  usage, so a first attempt that failed validation is never billed against the ceiling. dockg
  recorded this as a known limitation. A reader trusting the number deserves to know their ceiling
  is soft, and by roughly how much.

## Gate before, not after

Both existing judge consumers check the accumulated cost against the ceiling *before* dispatching
the next ensemble. Checking afterwards means the overspend has already happened. Show the loop, not
just the function.
