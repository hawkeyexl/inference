---
id: aud-extraction-integrators
type: audience
segment: Structured-extraction integrators using the completion layer only
maturity: moderate — completion layer, no judge layer
lead: false
docs_owner: The maintainer of one feature inside a larger CLI
firmographics:
  - Owns a CLI whose main job is deterministic; inference is one optional feature inside it
  - Needs one schema-constrained call per subject, not N runs and a vote
  - Already has Ajv, subprocess handling, and a config file of its own
  - Gates the feature on a per-run cost ceiling
  - TypeScript, ESM, Node 24+, vitest
relationship_stages:
  - Adding an optional LLM-backed feature to an existing deterministic tool
  - Steady-state consumer tracking a caret range
personas:
  - persona-marco
---

Integrators who use only the **completion layer** — `completeValidatedJSON`, the cache, the price
table — to add one schema-constrained call to a tool that is otherwise deterministic. For the
reader inside it, see [`persona-marco`](../personas/marco.md).

Distinct from [`aud-ensemble-tool-builders`](ensemble-tool-builders.md) in a way that matters for
every page: they never need consensus, zones, or agreement ratios. Content that opens with an
ensemble loses them immediately. The judge layer is something they must be able to *ignore*, and
the docs have to make ignoring it easy.

## What they own, and what they hand to this library

They own the schema, the prompt, and the failure policy — what their CLI does when the model
returns nothing usable. They hand over the provider call, validation, the retry, and the cost math.

The characteristic move in this segment is **splitting the request schema from the validation
schema**: send the model a schema narrowed to exactly the fields missing from this document, but
validate against the wider configured set. `CompleteValidatedOptions.validate` is what makes that
expressible, and dockg's ADR names it as the reason the extraction was possible at all.

## Defining pains, from the evidence

- **The validator cache is keyed on schema object identity.** dockg built a fresh schema object per
  call and recompiled Ajv once per document before discovering this, then had to memoize
  `proposalSchema` on the sorted field set. The behavior is deliberate and correct; it is explained
  only in a source comment inside `src/complete.ts`.
- **A retried request under-reports cost.** `InferenceRun` carries only the successful attempt's
  usage, so a failed first attempt's input tokens never reach the budget gate. dockg recorded this
  as a known limitation. A reader gating on `maxCostUsd` needs to know their ceiling is soft.
- **The exec seam is useful for things that are not inference.** dockg imports `realExec` and
  `ExecFn` to drive `git log`. This is a legitimate, tested, cross-platform subprocess helper that
  nothing in the docs presents as usable on its own — and the one type fix the extraction required
  (`ExecOptions.env` accepting `undefined`, so an inherited variable can be *unset* rather than set
  to empty) came from exactly this use.
- **`InferenceError` must be translated.** Same pain as the lead audience, same cause: exit-code
  mapping in the host CLI only understands the host's own error class.

## Buying constraints

The feature is optional in their product, so it must degrade rather than fail. A missing API key, a
read-only cache directory, or a blown budget has to produce a warning and a clean exit — never a
stack trace. The library's "an errored run is recorded, never dropped and never coerced" invariant
is what makes that possible, and this segment needs it stated plainly rather than discovered.

## Qualified reader

They bring TypeScript, ESM, Ajv, subprocess work, and budget gates. They do **not** bring
consensus math, ensembles, or anything about LLM-as-judge — and should never need to.
