---
id: aud-local-model-operators
type: audience
segment: Offline and cost-zero operators running GGUF weights in-process
maturity: varies — the constraint, not the integration depth, defines this segment
lead: false
cross_cutting: true
overlaps:
  - aud-ensemble-tool-builders
  - aud-extraction-integrators
  - aud-evaluating-adopters
docs_owner: Whoever owns the environment the tool runs in — often the same person as the integrator
firmographics:
  - Runs in CI, on an air-gapped network, or on a laptop with no funded API account
  - Cannot or will not put a provider API key in the environment
  - Has GPU VRAM or system RAM to spend, and needs to know how much
  - Tolerates multi-gigabyte downloads once, but must be able to reclaim the disk
relationship_stages:
  - Blocked on a key and looking for a way around it
  - Running local as the default and a hosted provider as the exception
  - Managing accumulated weights on a shared or constrained machine
personas:
  - persona-owen
---

Operators running the `llama-cpp` provider: GGUF weights in-process via `node-llama-cpp`, no
daemon, no API key, no per-token cost. For the reader inside it, see
[`persona-owen`](../personas/owen.md).

## Why this is a cross-cutting lens, not a fourth segment

The three other audiences are defined by *what they build*. This one is defined by *a constraint on
where it runs* — and that constraint can land on any of them. A tool builder running ensembles in
CI without secrets, an extraction integrator on an air-gapped network, and an adopter who wants to
try the package before creating an account are all this reader.

It earns a dedicated track anyway, because the constraint changes the entire path rather than
adding a flag: an optional peer dependency to install, an async factory where every other provider
uses a sync one, a model to choose, gigabytes to download and later reclaim, and a specific set of
schema features that silently stop working. That is a journey. The overlap is deliberate — Owen's
journeys are entered *from* the other tracks, and every track links into them.

## What they own, and what they hand to this library

They own the machine: how much VRAM and RAM it has, how much disk they can spare, and whether a
multi-gigabyte first-run download is acceptable. They hand over model selection, the download, the
grammar compilation, and the process-wide weight cache.

## Defining pains

- **Cost accounting goes quiet.** There is no price-table entry for a local model, so `pricingFor`
  returns `undefined` and every budget gate evaluates to zero spend. That is correct — the run
  genuinely costs nothing per token — but a reader who moved a budget-gated pipeline to local needs
  to understand their gate is now inert rather than passing.
- **Selectors cannot be resolved synchronously.** `auto` reads GPU memory, which needs an `await`.
  `makeProvider` and `resolveProviderIdentity` therefore *throw* on an unresolved selector rather
  than recording the literal `"auto"` as cache-key material. This is the single most likely first
  error in this segment, and the message has to teach rather than merely fail.
- **Three schema features quietly stop working.** `required` is ignored and every key in
  `properties` is emitted; `additionalProperties` defaults to `false`; numeric bounds are not
  grammar-enforced and come back as well-formed but out-of-range JSON. Schema `description`s are
  invisible to the grammar, so the provider restates the schema in the prompt. A schema that works
  against Anthropic can behave differently here, and the reader must find that out from a page
  rather than from a bad verdict.
- **Thinking is off by default.** A grammar constrains generation from token zero, which cuts a
  reasoning model off mid-thought. `thoughtTokens` is the knob, and nothing signals its existence
  at the moment quality looks wrong.
- **Weights accumulate, and deleting them is hazardous.** This library owns
  `~/.hawkeyexl-inference/models` precisely so that clearing it cannot destroy models something
  else downloaded. Readers pointing `directory` somewhere shared need the guarantees stated:
  only `.gguf` and `.gguf.ipull`, top level only, loaded weights disposed first because a
  memory-mapped file cannot be deleted on Windows.

## Buying constraints

Disk and memory, not money. `auto` sizes to the machine using the larger of free VRAM and half of
system RAM, with a 3.5× headroom multiplier over the model's file size. Readers need the mapping
from "what my machine has" to "what I will get" before triggering a download, and the exported
`LLAMA_MODELS` catalog is how they inspect sizes and licenses first.

## Qualified reader

They bring CI and environment ownership, and awareness of their machine's GPU and RAM. They do
**not** bring GGUF, quantization, QAT, or grammar-constrained decoding. Explain what a tier buys
them; do not explain what a quant is beyond why the catalog pins an exact blob path rather than a
`:QUANT` tag — that one matters, because a re-pointed tag would silently change results under a
cache key that already names the model.
