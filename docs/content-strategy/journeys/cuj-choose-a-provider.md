---
id: cuj-choose-a-provider
code: R2
type: cuj
title: Pick and configure a provider
personas:
  - persona-rin
  - persona-priya
  - persona-marco
trigger: The reader has a working call against MockProvider and needs it to reach a real model
entry_point: /get-started/choose-a-provider/
success_criteria: >
  The reader picks a provider on an informed basis, configures it through ProviderSpec, understands
  that swapping later is a one-line change, and knows which providers report token usage.
steps:
  - stage: Skip the choice entirely
    doc: /get-started/choose-a-provider/
    exists: true
    note: Omitting provider (or passing "auto") detects the highest-priority one this machine can use, ending at the free local model. mock is never auto-selected because an unscripted empty result would pass as real.
  - stage: Compare the five providers
    doc: /get-started/choose-a-provider/
    exists: true
    note: Table of structured-output mechanism, credential, and whether usage is reported. Usage is the column that decides whether cost accounting works at all.
  - stage: Learn the spec shape
    doc: /get-started/choose-a-provider/
    exists: true
    note: ProviderSpec is flat and library-owned. Map your own config into it; never pass your config object. Links ADR 01000.
  - stage: Set credentials
    doc: /get-started/choose-a-provider/
    exists: true
    note: Default env vars per provider, apiKeyEnv to override, and the providers that need no key at all.
  - stage: Get identity without constructing
    doc: /get-started/choose-a-provider/
    exists: true
    note: resolveProviderIdentity returns provider and model with no client and no key — so a fully-cached run needs no credentials. All three existing consumers reinvented this.
  - stage: Handle the provider-specific edges
    doc: /get-started/choose-a-provider/
    exists: true
    note: openai strict-mode rewriting and its json_object fallback; claude-cli stdin and no usage reporting; llama-cpp needing the async factory.
  - stage: Look up the full option set
    doc: /reference/providers/
    exists: true
    note: Every ProviderSpec field, every per-provider options interface, and the default model table.
  - stage: Go local instead
    doc: /local/
    exists: true
    note: Exit to O1 for readers who cannot use a credential at all.
---

Choosing among `anthropic`, `openai`, `claude-cli`, `llama-cpp`, and `mock`, and configuring the
choice. Shared by three personas, which makes it the most-traversed journey in the set after the
on-ramp.

Scoped to selection and configuration. What each provider does under the hood is
[`/reference/providers/`](../information_architecture/proposed-ia.md); running locally is
[`cuj-run-locally`](cuj-run-locally.md).

## The framing that has to land

**The choice is optional, and it is not a commitment.** Omitting `provider` detects one, and
swapping later is a one-line change against a flat, library-owned `ProviderSpec`. Readers who do not
know either fact will over-deliberate a reversible, skippable decision — and the page's first job is
to defuse it.

The second job is the inverse: one part of the choice **is** consequential, and it is easy to miss.

## Usage reporting is the consequential column

`claude-cli` reports no token usage. That is not a minor gap — it means `costOfUsage` and
`costOfRuns` yield `0`, and any budget gate over that provider is inert. A reader picking
`claude-cli` because it needs no API key should understand they are also giving up cost accounting.

This is the same trap Owen hits locally, arriving by a different road. Both pages state it, and both
distinguish **costs zero** from **cannot be priced**.

## Identity without construction

`resolveProviderIdentity(spec)` returns `{ provider, model }` with no client constructed and no key
required. Cache keys and pricing lookups need the identity; a fully-cached run should not demand a
credential.

All three existing consumers rediscovered this independently and each wrote its own lazy
`getProvider()` thunk around it. Documenting the pattern here — not just the function — is the point
of this step.

## Provider edges worth naming

- **`openai`** targets any `/chat/completions` server. It rewrites the schema into the strict subset
  and strips the resulting nulls back out; if the server rejects `response_format`, it permanently
  falls back to `json_object` with the schema in the prompt. Keyless local servers are allowed —
  only `api.openai.com` requires a key.
- **`claude-cli`** uses local CLI auth. The prompt goes over stdin, never argv, because user content
  routinely exceeds the ~32K Windows command-line limit.
- **`llama-cpp`** needs `makeProviderAsync` whenever the model is a selector. Hand off to O1.
