---
id: cuj-test-without-network
code: X1
type: cuj
title: Test my integration without a network
personas:
  - persona-priya
  - persona-marco
  - persona-rin
  - persona-owen
cross_cutting: true
trigger: A unit test would otherwise need an API key, a network, or multi-gigabyte weights
entry_point: /keep-it-working/testing/
success_criteria: >
  The author's whole integration is exercised in unit tests with no network and no credentials,
  using the three injection seams, including every failure path.
steps:
  - stage: Learn the three seams
    doc: /keep-it-working/testing/
    exists: true
    note: MockProvider for anything above the provider contract, ExecFn for claude-cli, LlamaRuntime for llama-cpp. One seam per boundary that would otherwise leave the process.
  - stage: Script a provider
    doc: /keep-it-working/testing/
    exists: true
    note: MockProvider takes an array of responses and cycles when exhausted. mockVerdict builds a VERDICT_SCHEMA-shaped payload. Sample is examples/testing-seams.mjs.
  - stage: Assert on what was sent
    doc: /keep-it-working/testing/
    exists: true
    note: provider.requests records every CompleteJSONRequest in order — the way to test that a prompt and schema were composed correctly.
  - stage: Exercise the failure paths
    doc: /keep-it-working/testing/
    exists: true
    note: An { error } entry rejects. This is how to prove an errored run forces human-review, and that a bad response never becomes data.
  - stage: Fake a subprocess
    doc: /keep-it-working/testing/
    exists: true
    note: Pass an ExecFn through ProviderSpec.exec. Assert on the argv and the piped stdin without spawning anything.
  - stage: Fake a local runtime
    doc: /keep-it-working/testing/
    exists: true
    note: Pass a LlamaRuntime through ProviderSpec.llamaRuntime or llamaCpp.runtime. Drives the full local path with no weights and no GPU.
  - stage: Keep your own docs honest
    doc: /keep-it-working/testing/
    exists: true
    note: How this docset does it — examples in examples/, rendered by raw import so a page cannot drift, executed in CI by Doc Detective.
  - stage: Look up the mock API
    doc: /reference/providers/
    exists: true
    note: MockProvider, MockResponse, mockVerdict, and the ProviderSpec injection fields.
---

Exercising an entire integration — including every failure path — in unit tests that never touch the
network, a credential, or a gigabyte of weights.

Cross-cutting: all four personas complete this journey, from four different tracks. It is the only
CUJ in the set with no primary persona.

Scoped to testing a consumer's integration. Testing this library itself is a contributor concern and
lives in `CLAUDE.md`.

## Why it is cross-cutting rather than a section of each track

Every persona hits the same wall at the same moment — the first unit test — and the answer is
identical for all of them. Repeating it four times would be four places to drift. Repeating it zero
times would leave it undiscoverable from three tracks.

So it gets one page, linked from every track, written so that a reader arriving from any of them
finds their case in the first screen.

## One seam per boundary

The design is worth stating explicitly, because it explains why there are three seams rather than
one mocking framework:

| Boundary | Seam | Injected via |
|---|---|---|
| The provider contract | `MockProvider` | Constructed directly, or `ProviderSpec.mockResponses` |
| A subprocess | `ExecFn` | `ProviderSpec.exec` |
| Native local inference | `LlamaRuntime` | `ProviderSpec.llamaRuntime` or `llamaCpp.runtime` |

Each is the narrowest thing that could be faked at that boundary. The library uses exactly these
seams on itself — every unit test in `test/unit/` runs through one of them, and the only live tests
are gated on environment variables and skipped by default.

## The failure paths are the point

A scripted `{ error: "429 rate limited" }` entry is what proves the guarantees a consumer is
building on:

- An errored run forces `human-review`, no matter how confident the others were.
- `completeValidatedJSON` returns a run with `error` set rather than throwing or coercing.
- A budget gate stops before the next call rather than after the overspend.

None of that can be verified against a live provider on demand. Priya in particular will not ship
without it — her product promise is exactly these guarantees.

## `provider.requests` deserves prominence

It records every `CompleteJSONRequest` in order, which makes it the way to test the part a consumer
actually owns: that the prompt and schema were composed correctly. Consumers own their prompts, so
this is the assertion that matters most and it is easy to miss.

## Closing the loop

The page ends by showing how this documentation set keeps itself honest with the same tools —
samples in `examples/`, rendered into pages by a `?raw` import so a page cannot drift from the file,
and executed in CI. It is the most credible possible demonstration that the pattern works, and it
costs a paragraph.
