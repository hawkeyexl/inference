---
id: cuj-custom-verdict-schema
code: P4
type: cuj
title: Word my own verdict schema
personas:
  - persona-priya
trigger: The built-in verdict schema's field descriptions do not speak the author's domain
entry_point: /judge/verdict-schema/
success_criteria: >
  The author ships a domain-worded verdict schema through the override seam, keeps it
  JudgeVerdict-shaped, and understands that the shape contract is enforced at runtime rather than
  at compile time.
steps:
  - stage: Learn that the seam exists
    doc: /judge/verdict-schema/
    exists: true
    note: EnsembleOptions.schema is the override. It appears in ADR 01001 and in the type, and nowhere in the current README. Both existing judge consumers depend on it.
  - stage: Understand why descriptions matter
    doc: /judge/verdict-schema/
    exists: true
    note: Field descriptions are prompt surface that measurably steers the model. docevals' and agentevals' schemas differ from the built-in one only in $id, title, and descriptions.
  - stage: Start from the canonical schema
    doc: /judge/verdict-schema/
    exists: true
    note: VERDICT_SCHEMA is exported. Five required fields, additionalProperties false, confidence bounded 0 to 1.
  - stage: Pass the override
    doc: /judge/verdict-schema/
    exists: true
    note: EnsembleOptions.schema on runEnsemble and judge. The validator is compiled once for the whole ensemble.
  - stage: Keep it JudgeVerdict-shaped
    doc: /judge/verdict-schema/
    exists: true
    note: The known hole: an override that does not produce JudgeVerdict-shaped objects fails at runtime, not at compile time. State it, and give the check.
  - stage: Mind the local-model caveats
    doc: /local/choosing-a-model/
    exists: true
    note: Under a grammar, descriptions are invisible and restated in the prompt, required is ignored, and bounds are not enforced. A custom schema with optional fields behaves differently locally.
  - stage: Look up the canonical schema
    doc: /reference/judge/
    exists: true
    note: VERDICT_SCHEMA contents and the JudgeVerdict type.
---

Replacing the built-in verdict schema with one worded for the author's own domain, without losing
the shape the consensus math depends on.

Scoped to the schema override. Running the ensemble is
[`cuj-judge-ensemble`](cuj-judge-ensemble.md).

## Why this journey exists at all

`EnsembleOptions.schema` is the seam that both existing judge consumers depend on, and it is
**absent from the current README**. It appears in ADR 01001 and in the type definition. A reader who
never opens the ADRs cannot discover it.

That is the single clearest documentation gap in the evidence: a capability that is deliberate,
load-bearing, used in production by two consumers, and undiscoverable.

## The insight that justifies the seam

The consumers' schemas differ from the canonical one only in `$id`, `title`, and **field
descriptions**. Not in structure. That looks trivial until you know why it matters:

> Field descriptions are prompt surface. They reach the model and measurably steer it.

A schema whose `claim` field is described in terms of documentation pages produces different
verdicts than one described in terms of agent traces. That is the entire reason the override exists,
and it is the thing to lead the page with.

## The hole, stated plainly

An override schema that does not produce `JudgeVerdict`-shaped objects fails **at runtime, not at
compile time**. The library validates the response against whatever schema it was given; it does not
verify that the schema's shape matches `JudgeVerdict`. A missing `confidence` field yields runs that
validate and then break the consensus math.

ADR 01001 records this as a known limitation. The page must state it and give the reader a concrete
guard — start from `VERDICT_SCHEMA`, change only `$id`, `title`, and descriptions, and add a
round-trip check with `MockProvider` to the reader's own test suite.

## Cross-link that must not be dropped

A custom schema with optional fields or bounded numbers behaves differently under a local model's
grammar: `required` is ignored, `additionalProperties` defaults to `false`, and numeric bounds are
not enforced. Anyone wording their own schema needs that pointer, even if they are not on the local
track today.
