---
id: persona-owen
type: persona
name: Owen
audience: aud-local-model-operators
lead: false
cross_cutting: true
role: Owns the environment a tool runs in — CI, an air-gapped network, or an unfunded laptop
proficiency:
  - CI pipelines, secrets policy, and why a job has no API key
  - Machine resources — GPU VRAM, system RAM, available disk
  - Node and npm, including optional peer dependencies
  - Reading a stack trace back to a configuration mistake
prerequisites:
  - Knows the tool he is running already works against a hosted provider
  - Knows roughly what hardware he has
  - Accepts a one-time multi-gigabyte download if he can reclaim the disk later
goals:
  - Run the whole pipeline with no API key and no per-token cost
  - Get a model sized to the machine without researching model families
  - Know what a run will cost in disk and memory before triggering a download
  - Reclaim the disk safely, without destroying weights something else owns
pains:
  - A selector throws from the sync factory, and the reason is not obvious in the moment
  - Budget gates silently evaluate to zero spend, so a cost ceiling becomes inert
  - required is ignored, additionalProperties defaults to false, numeric bounds are not enforced
  - Schema descriptions are invisible to the grammar
  - Thinking is disabled by default, so a reasoning model underperforms with no signal
  - Weights accumulate, and clearing a shared directory is genuinely hazardous
content_types:
  - Setup guides with prerequisites stated before the first command
  - Hardware-to-outcome mapping tables
  - Explicit lists of what does not work, and what to do instead
  - Safety guarantees stated as guarantees
journeys:
  - cuj-run-locally
  - cuj-choose-a-local-model
  - cuj-manage-model-files
  - cuj-test-without-network
  - cuj-upgrade-safely
---

Owen owns the environment, not the integration. Someone else's tool — Priya's, Marco's, or his
own — already works against a hosted provider. Owen's problem is that the environment cannot have
an API key: a CI job without secrets, an air-gapped network, or a laptop with no funded account.

He is a **cross-cutting persona**. He arrives from another track, carrying that track's goals plus
one constraint, and he returns to it once local execution works.

## What he is really solving

**Removing a dependency on credentials without changing what the tool does.** He is not shopping
for a model. He wants the same pipeline, the same verdicts, the same schema — minus the key. That
framing matters, because content organized around model families or quantization formats answers a
question he did not ask.

His decisions are all resource trades: disk against quality, memory against speed, download time
against convenience. Money never enters it, which is exactly what makes one of his pains so sharp.

## The first error he will hit

`makeProvider({ provider: "llama-cpp" })` throws, because the default model is the selector `auto`
and resolving it reads GPU memory, which needs an `await`. The synchronous factory refuses rather
than recording the literal `"auto"` as cache-key material — which would let a 2.6 GB and a 6.7 GB
model share cached results, and make one key mean different things on two machines.

That refusal is correct and worth explaining, because the reasoning is not guessable from the error.
`makeProviderAsync` is the answer, it delegates to the sync form for every other provider, and a
reader can switch over wholesale. This belongs on the first page of his track, not the third.

## The trap nobody warns him about

Owen usually arrives from a budget-gated pipeline. Locally there is no price-table entry, so
`pricingFor` returns `undefined` and `costOfRuns` yields `0`. Every `maxCostUsd` gate now passes
unconditionally.

Nothing is broken — the run genuinely costs nothing per token — but his gate is **inert**, not
satisfied. If he later switches one stage back to a hosted provider, that gate is still inert if the
model is not in the price table. He needs the distinction between "costs zero" and "cannot be
priced" stated once, clearly.

## Where his schema stops behaving

Four behaviors change under grammar-constrained decoding, and a schema that works against a hosted
provider can quietly behave differently:

- `required` is ignored; every key in `properties` is always emitted.
- `additionalProperties` defaults to `false`.
- Numeric bounds are not grammar-enforced — a violation comes back as well-formed JSON and is caught
  by the normal Ajv validation and retry.
- `description`s are invisible to the grammar, so the provider restates the schema in the system
  prompt. Descriptions still steer the model; they just arrive by a different route.

These are upstream behaviors, not bugs, and none of them affect the built-in `VERDICT_SCHEMA`. They
matter to anyone with optional fields or bounded numbers, and they need to be a list he can scan,
not prose he has to mine.

## Writing for him

- Prerequisites before the first command, always. `node-llama-cpp` is an optional peer dependency
  and is not installed unless he asks.
- Lead with `makeProviderAsync`. Explain the throw as a design choice with a reason.
- Map hardware to outcome in a table: what `auto` picks, at what memory, with what headroom.
- State the disk-safety guarantees as guarantees: only `.gguf` and `.gguf.ipull`, top level only,
  never recursing, loaded weights disposed first because a memory-mapped file cannot be deleted on
  Windows. He is being asked to trust a delete operation.
- Give him `dryRun` before he needs it.
- Never assume GGUF or quantization vocabulary. Do explain why the catalog pins an exact blob path
  instead of a `:QUANT` tag — a re-pointed tag would silently change results under a cache key that
  already names the model, and that is his problem, not trivia.
