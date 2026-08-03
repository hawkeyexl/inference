---
status: "accepted"
date: 2026-08-03
decision-makers: [hawkeyexl]
---

# One entry point, and a canonical verdict schema with an override seam

## Context and Problem Statement

The extracted code splits cleanly into two layers: schema-constrained completion (provider
contract, providers, cache, cost, validate-and-retry) and LLM-as-judge (verdict schema, N-run
ensemble, consensus math, confidence zones). docevals and agentevals need both; dockg's `fill`
needs only the first, and a future docmeta inference path probably will too.

Two questions followed. Should the judge layer be a separate subpath export so completion-only
consumers do not see it? And whose verdict schema is canonical, given that docevals and agentevals
each ship one?

## Decision Drivers

- Consumers should not have to learn which of several import paths a symbol lives at.
- A completion-only consumer should not be forced to reason about judging.
- docevals' and agentevals' verdict schemas differ only in `$id`, `title`, and field
  *descriptions* — and those descriptions are prompt surface that measurably steers the model.
- Every consumer already persists `JudgeRun[]` to an on-disk cache.

## Considered Options

- Single entry point exporting both layers
- Two subpath exports: `.` for completion, `./judge` for judging
- Two separate packages

## Decision Outcome

Chosen option: **a single entry point exporting both layers**, with the judge layer built on the
completion layer and inert if unused. `dist/index.js` is roughly 20 kB; the cost of carrying unused
judge exports is not worth a second import path in four consuming codebases.

For the schema: **ship the canonical structure as `VERDICT_SCHEMA` and let `runEnsemble` take a
`schema` override.** The default carries domain-neutral descriptions; agentevals passes its own
trace-specific wording, docevals its own page-specific wording, and both get the same validation,
consensus, and zone logic.

`JudgeRun` keeps its field name `verdict` rather than the completion layer's generic `result`,
because consumers persist `JudgeRun[]` to disk. `runEnsemble` maps `result` to `verdict` at the
boundary.

### Consequences

- Good, because there is one import path to document and one to remember.
- Good, because domain-specific prompt wording — the thing that actually affects verdict quality —
  stays with the consumer that owns the domain.
- Good, because existing consumer cache files stay readable: the persisted shape is unchanged.
- Bad, because dockg's dependency graph includes Ajv-compiled judge code it never calls. It already
  depended on Ajv directly, so this is not a new dependency.
- Bad, because a consumer passing an override schema that does not produce `JudgeVerdict`-shaped
  objects will fail validation at runtime rather than compile time. The schema is data, so this is
  unavoidable without a much heavier design.

### Confirmation

`test/unit/judge.test.ts` asserts `runEnsemble` sends `VERDICT_SCHEMA` by default, sends a
consumer-supplied schema when given one, and still produces a valid verdict in both cases. The
`InferenceRun.result` → `JudgeRun.verdict` mapping is covered by the same suite's cache-replay test,
which compares persisted verdicts across two runs.

## Pros and Cons of the Options

### Single entry point

- Good, because it is the least surface for a consumer to learn.
- Good, because the layering is still enforced in the source tree (`src/judge/` imports from
  `src/`, never the reverse).
- Bad, because completion-only consumers ship a little dead code.

### Two subpath exports

- Good, because the layer boundary would be visible in every import statement.
- Bad, because every consumer would face a "which path is `MockProvider` in?" question forever, and
  `MockProvider` genuinely belongs to both (`mockVerdict` is judge-shaped, the provider is not).
- Bad, because subpath exports interact badly with some bundler and TypeScript resolution settings,
  for a saving measured in single-digit kilobytes.

### Two packages

- Bad, because it doubles the release, versioning, and CI overhead to solve the same
  single-digit-kilobyte problem, and reintroduces exactly the cross-package coupling this
  extraction exists to remove.
