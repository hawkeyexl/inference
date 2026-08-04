---
id: aud-ensemble-tool-builders
type: audience
segment: Eval and judging tool authors building on the judge layer
maturity: deep — both layers, nearly the whole export surface
lead: true
docs_owner: The tool's own maintainer; usually a solo maintainer or a two-person team
firmographics:
  - Ships a CLI or library that grades something — pages, traces, artifacts
  - Owns its own prompts, its own verdict schema wording, and its own cache-key composition
  - Persists this library's JudgeRun objects to an on-disk cache that must survive upgrades
  - Has exit codes and a budget gate that operational failures must map into
  - TypeScript, ESM, Node 24+, vitest
relationship_stages:
  - Migrating a hand-rolled provider layer onto this package
  - Steady-state consumer tracking a caret range
  - Upgrading across a change that may invalidate cached ensembles
personas:
  - persona-priya
---

Tool authors who use the **judge layer** — ensembles, consensus, and confidence zones — to turn a
model's opinion into a decision their CLI can act on. This is the lead audience. For the reader
inside it, see [`persona-priya`](../personas/priya.md).

## What they own, and what they hand to this library

They own the parts that are domain-specific and refuse to be generalized: the system prompt, the
wording of the verdict schema's field descriptions, what invalidates a cache entry, and where the
`human-review` zone routes to in their product. They hand over the parts that are the same
everywhere: talking to a provider, getting schema-valid JSON back, counting votes, pricing tokens.

That split is the library's whole thesis, and it is the thing new readers in this segment get wrong
first. They arrive expecting a framework and find a narrow contract.

## Defining pains, from the evidence

Every item here is drawn from a consumer's own ADR or source comment, not inferred.

- **An unknown model prices at zero, which silently disables every budget gate.** agentevals
  carries a `pricingOverrideFor()` helper threaded through both its judge and fill paths purely to
  work around this. The behavior is correct and deliberate — unknown is never a guess — but the
  *consequence* for a budget gate is documented nowhere the reader will look in time.
- **The per-consumer verdict-schema override is undiscoverable.** `EnsembleOptions.schema` is the
  seam both docevals and agentevals depend on, because field descriptions are prompt surface that
  measurably steers the model. It appears in ADR 01001 and in the type. It appears nowhere in the
  README.
- **Cache entries outlive the schema that produced them.** All three consumers independently
  invented a schema-recheck-on-read wrapper around `JsonCache`. Three teams solving the same
  problem three times is a documentation gap, not a coincidence.
- **Provider identity is needed without a provider.** All three independently rediscovered that a
  fully-cached run should not require an API key, and that `resolveProviderIdentity` exists for
  exactly that. Each wrote its own lazy `getProvider()` thunk to get there.
- **Operational errors arrive as a foreign type.** `InferenceError` has to be caught and re-wrapped
  into the consumer's own error class, or "no API key configured" turns from a warning into an
  unhandled stack trace with the wrong exit code.

## Buying constraints

There is no purchase; the constraint is upgrade risk. `JudgeRun` is persisted to their on-disk
caches, so its shape is a file format. A rename invalidates every cached ensemble in every
consuming repo — an expensive, silent, and entirely avoidable cost. This segment needs to know,
before upgrading, exactly what would invalidate their cache.

## Qualified reader

They bring TypeScript, ESM, JSON Schema, and prompt design. They own a CLI and think in exit codes.
They do **not** bring provider API quirks — the difference between a forced tool call and strict
`json_schema` mode is not knowledge they arrive with, and does not need to be, except where it
leaks (token limits, the `json_object` fallback, usage that some providers do not report).

Do not explain what JSON Schema is. Do explain what `toStrictSchema` rewrites and why.
