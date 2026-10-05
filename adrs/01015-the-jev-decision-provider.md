---
status: "accepted"
date: 2026-10-05
decision-makers: [hawkeyexl]
---

# Add `jev`, a hosted decision provider, that is never auto-detected and never answers `completeJSON`

## Context and Problem Statement

ADR 01013 added decisions as an optional provider capability and copied its request shape from
TypeSafe's Jev "System One" API. No provider yet answers them with a real model's probabilities
except the local one in progress. Jev is the hosted option: a purpose-built model that returns a
probability for each option of a question, at $0.042 per million input tokens and free output.

How should the library reach it, given that it is a decision-only service that needs a paid key?

## Decision Drivers

- A consumer must switch between the local and the hosted decision provider without rewriting its
  questions.
- Jev generates no text, so it must not look like a provider that does.
- Detection ends at a free local model on purpose. A paid hosted provider must never be picked
  without being named.
- Unknown price is `undefined`, and a moving alias has no known price.
- Tests must not call the network.

## Considered Options

- A `jev` provider that is a `DecisionProvider` only
- A separate `decide` client outside the provider factory
- A `jev` provider that also answers `completeJSON` by asking for an enum

## Decision Outcome

Chosen option: "A `jev` provider that is a `DecisionProvider` only", because it uses the factory,
the spec, the key handling and the cost table the other providers use, and it claims nothing it
cannot do.

### The API as verified

Read from TypeSafe's published docs (`docs.typesafe.ai/api.md`, `primitives/choice.md`,
`models.md`) on 2026-10-05:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>
{ "model": "jev-latest", "state": <string | object | array>,
  "questions": { "<id>": { "type": "choice", "instructions": "...",
                           "criteria": { "<option>": "<what it means>", ... } } } }

200 { "model": "jev-1.13.0",
      "answers": { "<id>": { "type": "choice", "choice": "...",
                             "confidence": 0.85,
                             "probabilities": { "<option>": 0.85, ... } } },
      "usage": { "input_tokens": 328, "output_tokens": 34 } }
```

A choice question's `criteria` is an **object of option id to description**. The docs also allow an
object of fields (`what`, `not_for`, `examples`) or `null` per option; this library sends the string
form, which is what `DecideQuestion.criteria` holds. A choice question takes up to 255 options.
`state` plus the longest question may be 32k tokens, inside a 64k request. The docs list 401, 422,
429 and 529. They do not describe an error body, so the provider reads `error`, `error.message`,
`message` or `detail`, in that order, and falls back to the start of the text.

### The mapping

`toJevRequest(model, request)` in `src/providers/jev.ts` is the only place a `DecideRequest`
becomes a Jev body. It is one-to-one: `state`, `questions[id].instructions` and
`questions[id].criteria` are copied, `type` is `"choice"`, and `model` is added. A test pins it.
Answers go the other way through `normalizeDecision`, so `choice` and `confidence` follow the shared
rule, not Jev's own fields. A probability naming an option the question lacks is an `InferenceError`
from that helper.

### The provider

- `new JevProvider(model, apiKeyEnv, { baseUrl, timeoutMs, fetch })`. The key is read from the
  environment, and a missing one throws at construction like the Anthropic provider does.
- `ProviderName` gains `"jev"`. `DEFAULT_MODELS.jev` is `"jev-latest"` and the default key variable
  is `TYPESAFE_API_KEY`.
- `ProviderSpec.baseUrl` was documented as openai only and `timeoutMs` as claude-cli only. Both now
  also apply to `jev`, and `ProviderSpec.jev` carries the rest. The default base URL is exported as
  `DEFAULT_JEV_BASE_URL`, beside `DEFAULT_OPENAI_BASE_URL`. The timeout is 60 seconds.
- `stateLimit()` is 32000.
- `completeJSON` rejects with an `InferenceError` saying the provider answers decisions only.
- `jev` is not in `DETECTION_ORDER`. Detection exists to find a free provider that works with no
  setup. A hosted, paid, decision-only one fits neither description.

### Failures

Every failure is an `InferenceError` with a message a person can act on: 401 names the key
variable, 422 carries Jev's reason, 429 and 529 say to retry with backoff, any other status gives its
code and the start of the body, a network error or a timeout says so, and a 200 whose body lacks an
answer, its type or its probabilities is "a response this library cannot read". The library does not
retry. A decision has no schema to revalidate, and a consumer knows better than a library whether a
rate-limited call is worth waiting for.

### Price

`PRICE_TABLE` gains `jev-1.13.0` at $0.042 input and $0 output, from the models page. It does not
gain `jev-latest`. That name is an alias TypeSafe re-points, so a price recorded for it would
quietly be wrong after the next release, and a budget gate would trust it. With no entry the cost of
a `jev-latest` run is unknown, which is `0` by the repo's rule. A consumer who accepts today's price
passes `pricing`, or names `jev-1.13.0`.

### Consequences

- Good, because the hosted and local decision providers take the same request, so a consumer
  switches by changing `provider`.
- Good, because the provider cannot be picked by accident, and cannot be asked for text it can't
  produce.
- Good, because the wire mapping is in one pinned function.
- Neutral, because `jev-latest` in a cache key does not pin the weights. A consumer who needs that
  names the pinned model.
- Bad, because the error body shape is inferred, not documented. A body of another shape still
  produces a useful message from its text.

### Confirmation

`test/unit/jev.test.ts` injects `fetch`, the only double, and pins the request mapping, the bearer
header, the URL, `baseUrl` and timeout handling, the normalization of a response, usage, the 255
option cap, each HTTP failure, network failure and timeout, and each malformed response. It also
asserts that detection never lists `jev` and that the price table holds the pinned model only.
`scripts/check-docs-exports.mjs` and `scripts/check-error-coverage.mjs` hold the reference pages to
the new exports and messages.

### Commit type

`feat`. It adds a provider name, exports and `ProviderSpec` fields. Nothing is removed or renamed.
`ProviderName` is a wider union, which breaks only a consumer that switches over it exhaustively.

## Pros and Cons of the Options

### A `jev` provider that is a `DecisionProvider` only (chosen)

- Good, because it reuses the factory, spec and cost conventions.
- Bad, because the provider names a service the library cannot test against in CI.

### A separate `decide` client outside the factory

- Good, because it can't be confused with a text provider.
- Bad, because key handling, the base URL, the timeout and the cost lookup would each be built a
  second time, and `canDecide` would no longer cover every decision provider.

### A `jev` provider that also answers `completeJSON`

- Good, because it would satisfy `InferenceProvider` fully.
- Bad, because Jev has no text mode. Faking one from an enum is the confidence-from-generated-text
  that ADR 01013 rejected.
