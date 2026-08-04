---
id: cuj-wire-into-a-cli
code: M4
type: cuj
title: Wire it into a CLI
personas:
  - persona-marco
  - persona-priya
trigger: The call works, and now it has to become a subcommand with flags, statuses, and an exit code
entry_point: /extract/cli-integration/
success_criteria: >
  The author ships a subcommand with a dry run that costs nothing on the real run, a per-subject
  status enum, an exit-code contract, and cache keys that make a re-run additive rather than a
  replay.
steps:
  - stage: Give every subject a status
    doc: /extract/cli-integration/
    exists: true
    note: filled, complete, skipped-budget, error. All three consumers converged on this vocabulary independently. A boolean is not enough - budget exhaustion and a model failure are different outcomes.
  - stage: Map statuses to exit codes
    doc: /extract/cli-integration/
    exists: true
    note: 0 clean, 1 findings, 2 operational. This is where a translated InferenceError lands, and it is why translation at the boundary matters.
  - stage: Add a dry run
    doc: /extract/cli-integration/
    exists: true
    note: A dry run over an LLM-backed command still makes and pays for every call. What makes the follow-up real run free is the cache - so the dry-run flag must not be part of the cache key.
  - stage: Skip before you spend
    doc: /extract/cli-integration/
    exists: true
    note: Put the existing output state in the key. A second run then asks the model for what is still missing rather than replaying a proposal already applied, and a subject with nothing missing costs no call at all.
  - stage: Gate the write on confidence
    doc: /extract/cli-integration/
    exists: true
    note: A schema-valid answer can still be a bad answer. Ask the model to score itself, refuse to write below a threshold, and cache the proposal before gating so re-tuning the threshold costs nothing.
  - stage: Choose where the cache lives
    doc: /judge/caching/
    exists: true
    note: A dot-directory per tool, a subdirectory per command, never cross-read, and a depth-agnostic gitignore pattern.
  - stage: Handle the failures
    doc: /extract/budgets-and-errors/
    exists: true
    note: The two error classes and the degrade-rather-than-fail rule this journey builds its statuses on.
---

Turning a working call into a subcommand somebody else can run.

Scoped to the CLI surface around the library. The call itself is
[`cuj-single-shot-extraction`](cuj-single-shot-extraction.md); running many subjects concurrently is
[`cuj-run-at-scale`](cuj-run-at-scale.md).

## Why this is a journey and not a footnote

Every consumer of this package built the same CLI scaffolding, and the docset showed none of it.
Three independent implementations converged on the same status vocabulary, the same exit-code map,
the same dry-run semantics, and the same trick for making re-runs additive. That convergence is the
evidence: it is not incidental glue, it is the shape this library implies.

## The two non-obvious ones

**A dry run is not free.** The natural reading of `--dry-run` is "don't do the expensive thing." For
an LLM-backed command the expensive thing has already happened by the time you decide not to write —
the call was made and paid for. What makes the pattern work is the cache: the follow-up real run
hits it and costs nothing, *provided the dry-run flag is not part of the key*. State that, because
adding the flag to the key is the obvious mistake and it silently doubles the cost.

**Cache the pre-gated proposal.** If confidence gating happens before the cache write, re-tuning the
threshold re-runs every call. If it happens after, the reader can sweep thresholds for free. One
line of ordering, a large difference in what experimentation costs.

## The framing for the status enum

A per-subject result is not a boolean, and the four statuses are not arbitrary:

| Status | Meaning | Exit contribution |
|---|---|---|
| `filled` | the model proposed something and it was written | 0 |
| `complete` | nothing was missing; no call made | 0 |
| `skipped-budget` | the ceiling stopped it before the call | 0, with a warning |
| `error` | the call failed, or the response never validated | 1 |

`skipped-budget` is the one readers omit. Collapsing it into `error` makes a deliberate cost
decision look like a failure; collapsing it into `complete` hides work that was never done.
