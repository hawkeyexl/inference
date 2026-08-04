---
id: persona-priya
type: persona
name: Priya
audience: aud-ensemble-tool-builders
lead: true
role: Author and sole maintainer of an eval CLI that grades artifacts with an LLM-as-judge
proficiency:
  - TypeScript and ESM, Node 24+
  - JSON Schema authoring, including how field descriptions steer a model
  - Prompt design and iteration
  - CLI design — exit codes, degraded modes, machine-readable output
  - vitest, and a hard rule that her unit tests never touch the network
prerequisites:
  - Knows what an LLM-as-judge is and why one sample is not enough
  - Has a system prompt and a verdict shape already in mind
  - Understands content-addressed caching in principle
  - Owns a config file and knows which of its keys should map to provider settings
goals:
  - Turn a model's opinion into a decision her CLI can act on, with a defensible confidence story
  - Never let a provider failure become a silent pass
  - Make a re-run of an unchanged subject cost nothing
  - Keep total spend under a ceiling her users set
  - Word the verdict schema in her own domain's language
pains:
  - An unknown model prices at zero, silently disabling her budget gate
  - Did not know the verdict schema could be overridden — it is absent from the README
  - Reinvented a schema-recheck-on-read cache wrapper that two other consumers also invented
  - Reinvented resolve-identity-without-constructing so a fully-cached run needs no API key
  - InferenceError arrives as a foreign type and breaks her exit-code mapping
content_types:
  - End-to-end journey guides with runnable samples
  - Reference pages with full signatures and option tables
  - Explicit statements of guarantees and their boundaries
  - Decision tables — when this behavior applies and when it does not
journeys:
  - cuj-choose-a-provider
  - cuj-judge-ensemble
  - cuj-cache-repeat-runs
  - cuj-budget-judge-spend
  - cuj-custom-verdict-schema
  - cuj-cost-gate-and-degrade
  - cuj-test-without-network
  - cuj-upgrade-safely
  - cuj-run-at-scale
  - cuj-wire-into-a-cli
  - cuj-diagnose-a-failed-run
  - cuj-know-the-boundary
---

**Priya is the lead persona.** She maintains an eval CLI that grades artifacts — pages, traces,
outputs — by asking a model whether each satisfies an assertion, then turning N independent answers
into one decision her tool can act on.

She is the reader who touches every layer of this package: provider construction, schema override,
ensembles, consensus, zones, caching, cost gating, and the mock seam. Content written for her is
read by everyone else too, which is why her track carries the deepest coverage and why her journey
[`cuj-judge-ensemble`](../journeys/cuj-judge-ensemble.md) is the anchor.

## What she is really solving

Not "call a model." She is solving **"produce a decision I can defend."** Her users will ask why a
given artifact failed, and "the model said so" is not an answer. So she needs the ensemble to be
independent samples, the consensus math to be stated rather than implied, and the boundary between
auto-resolved and human-reviewed to be a rule she can point at.

This is why the safety property matters more to her than any feature: an errored run can push a
result toward human review, but it can never produce a silent pass. She will build on that
guarantee, so the docs must state it plainly and mark its edges — a tie is not a pass, `partial`
counts toward fail while staying visible in the vote breakdown, and any errored run in the ensemble
forces `human-review` regardless of the others.

## How she reads

She arrives with a working mental model and a specific question. She skims for the shape of an API,
then reads closely at exactly the point where a guarantee might not hold. She is unusually
sensitive to hedging: "generally," "should," and "in most cases" cost her trust, because she is
deciding whether to build a product promise on the sentence.

Give her the guarantee, then its exact boundary, then the sample. In that order.

## Where she gets hurt

The five items in `pains` above are all drawn from shipped code in docevals and agentevals, not
imagined. Three of them are the same failure: **a capability exists, is deliberate, and is
undiscoverable.** She did not need a feature built; she needed a page to exist.

The fourth is subtler and the most expensive. A cache entry outlives the schema that produced it,
and nothing in the library rejects a stale one, because `JsonCache` deliberately does not know what
shape any consumer stores. Three teams each discovered this the same way and each wrote the same
wrapper. Her page has to name the pattern so a fourth team does not.

## Writing for her

- Assume JSON Schema. Explain what `toStrictSchema` rewrites and why, because that is provider
  behavior leaking into her schema, not schema knowledge.
- Lead every judge-layer page with the decision, not the mechanism. `zone` before `agreement`.
- State the cost model as a rule with a consequence: unknown price is `undefined`, unknown cost is
  `0`, and **a budget gate over an unpriced model is inert**. The last clause is the part she needs.
- Never demonstrate `runEnsemble` without also showing what an errored run does to the result.
- Show cache-key composition as *her* responsibility. The library hashes what she names; it does
  not decide what invalidates an entry.
