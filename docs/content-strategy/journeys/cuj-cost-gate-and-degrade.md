---
id: cuj-cost-gate-and-degrade
code: M2
type: cuj
title: Gate a feature on cost and degrade gracefully
personas:
  - persona-marco
  - persona-priya
trigger: An optional LLM feature must stay inside a ceiling and must never break the host CLI
entry_point: /extract/budgets-and-errors/
success_criteria: >
  The feature stops cleanly at its cost ceiling, a missing key or read-only cache produces a warning
  and a correct exit code rather than a stack trace, and the deterministic path is never affected.
steps:
  - stage: Accumulate cost per call
    doc: /extract/budgets-and-errors/
    exists: true
    note: costOfUsage per run against a running total, checked before the next call.
  - stage: Know the ceiling is soft
    doc: /extract/budgets-and-errors/
    exists: true
    note: A retried request under-reports: only the successful attempt's usage is carried. State the size of the gap.
  - stage: Translate InferenceError
    doc: /extract/budgets-and-errors/
    exists: true
    note: Catch InferenceError at the boundary and re-wrap into the host's own error class, or exit-code mapping breaks and a config problem becomes an unhandled stack trace. All three consumers do this.
  - stage: Distinguish operational from model failure
    doc: /extract/budgets-and-errors/
    exists: true
    note: InferenceError is thrown for operational problems — missing key, unknown provider. A model failure is never thrown; it arrives as run.error. Different handling, different exit codes.
  - stage: Degrade rather than fail
    doc: /extract/budgets-and-errors/
    exists: true
    note: Warn and skip the optional feature. A read-only cache, a blown budget, or an absent key must leave the deterministic path untouched.
  - stage: Cross-check the pricing rules
    doc: /judge/cost-and-budgets/
    exists: true
    note: Shared with P3 — the price table, the override, and why an unpriced model makes a gate inert.
  - stage: Look up the signatures
    doc: /reference/cost/
    exists: true
    note: costOfUsage, costOfRuns, pricingFor, PRICE_TABLE.
---

Keeping an optional feature inside a cost ceiling, and making every failure mode land as a warning
and a correct exit code rather than a stack trace.

Scoped to gating and degradation for the completion layer. The pricing rules themselves are
[`cuj-budget-judge-spend`](cuj-budget-judge-spend.md), which this journey links to rather than
repeats.

## Two failure classes, handled differently

The distinction the page is built on, and the one readers most often collapse:

| Class | How it arrives | Example | Correct handling |
|---|---|---|---|
| **Operational** | Thrown as `InferenceError` | Missing API key, unknown provider name, unresolved local selector | Catch at the boundary, translate, exit with the host's config-error code |
| **Model** | Returned as `run.error` | Schema validation failed after both attempts, provider API error, timeout | Never thrown. Record it, skip the subject, continue or degrade |

Collapsing them turns a fixable configuration mistake into an unhandled stack trace, which is
exactly what happens to a host CLI that only maps its own error class to an exit code.

## The translation all three consumers wrote

docevals wraps `InferenceError` into `DocevalsError`, agentevals into `AgentevalsError`, dockg into
`DockgError` — each for the same reason: their `fail()` handler maps only their own error type to
the right exit code, so a foreign type escapes as a crash.

Three independent implementations of the same six-line boundary is a documentation gap. The page
shows the boundary once, generically.

## The soft ceiling

`InferenceRun` carries only the successful attempt's usage. A request that failed validation on the
first attempt and succeeded on the retry charges the budget for one attempt, not two — so the input
tokens of the failed attempt are invisible to the gate.

dockg recorded this as a known limitation rather than a bug, and it stays a limitation. The reader's
job is to know their ceiling is soft and to leave headroom; the page's job is to say so where the
ceiling is set, not in a footnote.
