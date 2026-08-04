---
id: cuj-choose-a-local-model
code: O2
type: cuj
title: Choose a model, or let auto choose
personas:
  - persona-owen
trigger: A local run works, and the operator needs to know what auto picked or how to override it
entry_point: /local/choosing-a-model/
success_criteria: >
  The operator maps their machine's memory to the tier auto will select, can name a model
  explicitly, and knows the four schema behaviors that change under grammar-constrained decoding.
steps:
  - stage: Understand what auto measures
    doc: /local/choosing-a-model/
    exists: true
    note: The larger of free GPU VRAM and half of system RAM, because llama.cpp offloads what fits to the GPU and keeps the rest in RAM. Sizing off VRAM alone would leave most of the machine idle.
  - stage: Map memory to tier
    doc: /local/choosing-a-model/
    exists: true
    note: The 3.5x headroom multiplier over file size, walking tiers smallest to largest and flooring at fast. A table from measured budget to the tier that results.
  - stage: Read the catalog before downloading
    doc: /local/choosing-a-model/
    exists: true
    note: LLAMA_MODELS is exported so sizes and licenses can be inspected before triggering a multi-gigabyte download. Sample is examples/local-catalog.mjs, which needs no weights.
  - stage: Name a model explicitly
    doc: /local/choosing-a-model/
    exists: true
    note: A tier keyword, a curated alias, a Hugging Face GGUF URI, or a local .gguf path. A bare user/repo is rejected as a typo'd alias rather than guessed at.
  - stage: Learn why blob paths are pinned
    doc: /local/choosing-a-model/
    exists: true
    note: Entries pin an exact blob path, not a :QUANT tag, so a model can never silently re-point underneath a cache key that already names it.
  - stage: Learn what changes under a grammar
    doc: /local/choosing-a-model/
    exists: true
    note: required ignored, additionalProperties defaults false, numeric bounds unenforced and caught by Ajv plus retry, descriptions invisible and restated in the prompt.
  - stage: Enable reasoning
    doc: /local/choosing-a-model/
    exists: true
    note: Thinking is disabled by default because a grammar constrains generation from token zero and cuts a reasoning model off mid-thought. thoughtTokens is the budget.
  - stage: Manage what you downloaded
    doc: /local/managing-model-files/
    exists: true
    note: Hands off to O3.
  - stage: Look up the catalog
    doc: /reference/local-models/
    exists: true
    note: LLAMA_MODELS entries, LLAMA_TIERS, tierForBudget, aliasForTier, uriForTier, resolveLlamaModelRef, isLlamaSelector.
---

Turning "what hardware do I have" into "what model will I get," and learning the schema behaviors
that change once a grammar is doing the constraining.

Scoped to selection and its consequences. Getting local working at all is
[`cuj-run-locally`](cuj-run-locally.md); reclaiming disk is
[`cuj-manage-model-files`](cuj-manage-model-files.md).

## Hardware to outcome, as a table

Owen's decisions are resource trades, so the page's centerpiece is a mapping he can read off:
measured memory budget → tier → alias → file size. The measurement rule and the 3.5× headroom
multiplier are what make the table reproducible rather than magic, and `tierForBudget` is exported
so a reader can check the answer for a machine they do not have in front of them.

The rule also needs its reasoning, because it looks odd at first glance: `auto` uses the **larger**
of free VRAM and half of system RAM, not VRAM alone, because llama.cpp offloads the layers that fit
onto the GPU and keeps the rest in system RAM. A box with a small GPU and plenty of RAM still runs a
big model well.

## Inspect before downloading

`LLAMA_MODELS` is exported precisely so an operator can see sizes and licenses before committing to
a multi-gigabyte download. That deserves to be a step, not a footnote — it is the difference between
an informed choice and a surprise on a metered connection.

All catalog entries are Apache-2.0 and ungated. Say so; license is a real gate in some environments.

## The pinning rule matters to him specifically

Entries pin an exact blob path rather than a `:QUANT` tag. If a tag could re-point, the same cache
key would silently mean different weights — and Owen is the persona most likely to have a populated
cache and the least likely to suspect the model changed underneath it.

This is the one piece of quantization-adjacent detail worth spending his attention on. Everything
else about quants can stay out.

## The four behaviors that change

These belong in a scannable list, not prose. A schema that works against a hosted provider can
behave differently here:

1. `required` is ignored — every key in `properties` is always emitted.
2. `additionalProperties` defaults to `false`.
3. Numeric bounds are not grammar-enforced; violations come back well-formed and are caught by the
   normal Ajv validation and retry.
4. `description`s are invisible to the grammar, so the provider restates the schema in the system
   prompt. Descriptions still steer the model — they arrive by a different route.

None affect the built-in `VERDICT_SCHEMA`, which requires all its fields. They matter to anyone who
completed [`cuj-custom-verdict-schema`](cuj-custom-verdict-schema.md), which is why that journey
links here.

## Thinking, and why it is off

A grammar constrains generation from token zero, which cuts a reasoning model off mid-thought.
`llamaCpp: { thoughtTokens: 512 }` buys reasoning before the JSON. Without this note, an operator
sees mediocre output and blames the model.
