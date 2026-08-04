---
id: persona-marco
type: persona
name: Marco
audience: aud-extraction-integrators
lead: false
role: Maintainer of a deterministic CLI, adding one optional LLM-backed extraction feature
proficiency:
  - TypeScript and ESM, Node 24+
  - Ajv and JSON Schema, including compiling validators himself
  - Cross-platform subprocess work, including Windows argv limits
  - Config precedence, cost ceilings, and graceful degradation
  - vitest
prerequisites:
  - Has a schema for the data he wants extracted
  - Knows the feature must be optional and must never break the deterministic path
  - Understands his own exit-code contract and where a failure has to land in it
goals:
  - Get one schema-valid object per subject, or an honest failure
  - Send a narrow schema to the model but validate against a wider one
  - Keep the feature inside a per-run cost ceiling
  - Fail soft — a missing key or a blown budget warns and exits clean
pains:
  - The validator cache is keyed on schema object identity; a fresh schema per call recompiles Ajv
  - A retried request under-reports cost, so the budget ceiling is softer than it looks
  - The exec seam is genuinely reusable for non-inference subprocesses, but nothing says so
  - InferenceError must be translated into his own error class for exit-code mapping
  - Judge-layer material in the way of completion-layer answers
content_types:
  - Short task-shaped guides with one runnable sample each
  - Reference pages with full signatures and defaults
  - Explicit statements about what is and is not guaranteed
  - Caveats stated where the decision is made, not in a footnote
journeys:
  - cuj-choose-a-provider
  - cuj-cache-repeat-runs
  - cuj-budget-judge-spend
  - cuj-single-shot-extraction
  - cuj-cost-gate-and-degrade
  - cuj-exec-seam
  - cuj-test-without-network
  - cuj-upgrade-safely
---

Marco maintains a CLI whose main job is deterministic and reproducible. He is adding one optional
feature that needs a model: given a document and a list of fields it is missing, propose values.
One call, one subject, one schema-valid object — or an honest failure his tool can report.

He is defined as much by what he does **not** need as by what he does. No ensembles, no consensus,
no zones, no agreement ratios. The judge layer is something he must be able to ignore completely,
and pages that open with it lose him on the first screen.

## What he is really solving

**Adding a non-deterministic feature to a tool whose value proposition is determinism.** That
tension governs every decision he makes. The feature has to be opt-in, has to be bounded in cost,
has to be reproducible when cached, and above all has to fail in a way that leaves the
deterministic path untouched.

This makes the library's "an errored run is recorded, never dropped and never coerced" invariant the
single most important thing he reads. He is not looking for a retry-until-success loop; he is
looking for a promise that a bad response never silently becomes data in his output.

## The move that defines him

Marco sends the model a schema narrowed to exactly the fields missing from *this* document, but
validates the response against the wider configured field set. Two schemas, one call.
`CompleteValidatedOptions.validate` is what makes that expressible, and it is the reason his
integration was possible at all.

Any page that presents `completeValidatedJSON` as taking one schema is incomplete for him. The
`schema` / `validate` split needs to appear on the page where he first meets the function, not
buried in Reference.

## Where he gets hurt

Two of his pains are performance and accuracy traps that the library handles correctly but does not
advertise:

- He built a fresh schema object per call and quietly recompiled Ajv once per document, because the
  validator cache is a `WeakMap` keyed on **schema object identity**. Memoizing his schema builder
  fixed it. This is explained only in a comment inside `src/complete.ts`.
- His budget ceiling is soft. `InferenceRun` carries only the successful attempt's usage, so a
  failed first attempt's input tokens are never charged. He needs this stated at the point where he
  decides to trust the number, not discovered when a bill disagrees.

The third is an opportunity rather than a wound: he imports `realExec` to drive `git log`. The exec
seam is a tested, cross-platform subprocess helper with real thought behind it — stdin over argv for
the Windows 32K limit, UTF-8 decoding across chunk boundaries, a timeout that settles on the timer
so a SIGTERM-ignoring child cannot hang the caller, and `env` values that accept `undefined` to
*unset* an inherited variable rather than blanking it. That last behavior exists because he needed
it. None of it is presented as usable on its own.

## Writing for him

- Never make him read about ensembles to learn about completion. The two layers ship from one entry
  point; the docs must keep them separable.
- Show `schema` and `validate` together, always.
- State the retry semantics as a rule: one call plus one retry by default, then a run with `error`
  set and `result` absent. Never a throw, never a coerced value.
- Put the cost caveat where the budget decision is made.
- Give the exec seam its own page. It is a real capability, not an implementation detail.
- Every sample must show the failure branch. He will write it before he writes the happy path.
