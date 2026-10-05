---
status: "accepted"
date: 2026-10-05
decision-makers: [hawkeyexl]
---

# Add decisions as an optional provider capability, in Jev's request shape

## Context and Problem Statement

manni's proposal 0079 checks each turn of an agent session against the rules the agent read. Each
check is a question with a fixed set of answers, such as "did the agent skip a git hook: yes or
no". What manni needs back is not text but a probability for each answer, so that a low-confidence
call can go to a human instead of passing silently.

`completeJSON` can't give that. A model asked for `{"answer": "yes"}` returns a sample, not a
distribution, and the confidence it writes into a field is more generated text. A real probability
comes from the model's own scores for the option tokens (llama.cpp) or from a service built for it,
such as TypeSafe's Jev "System One" API. Both answer a question over a fixed option set, and
neither generates JSON.

How should the library offer probability-over-options calls without widening the contract every
provider and consumer pays for?

## Decision Drivers

- The base contract stays `(system, user, schema, temperature) -> JSON`. `docevals`, `dockg` and
  `agentevals` must not notice the change.
- Not every provider can decide. The Anthropic and OpenAI APIs used here expose no option
  probabilities, and a provider that faked them would hand back confidence it does not have.
- One request shape must fit both a local implementation and a hosted one, so a consumer switches
  providers without rewriting its questions.
- Probabilities from different providers must mean the same thing, so a consumer's confidence
  thresholds carry across providers.
- Consumers test offline, so `MockProvider` must answer decisions.

## Considered Options

- Widen `InferenceProvider` with a required `decide`
- Express a decision as a `completeJSON` schema with an enum, and ask for a confidence field
- An optional `DecisionProvider` capability, detected with `canDecide`

## Decision Outcome

Chosen option: "An optional `DecisionProvider` capability", because it adds decisions for the
providers that can make them and changes nothing for those that can't.

### Interface

```ts
interface DecisionProvider extends InferenceProvider {
  decide(req: DecideRequest): Promise<DecideResponse>;
  stateLimit(): Promise<number>;  // tokens accepted for state plus the longest question
}
function canDecide(p: InferenceProvider): p is DecisionProvider;
```

`DecideRequest`, `DecideQuestion`, `DecideResponse` and `DecideAnswer` are exported types.
`canDecide` checks that `decide` and `stateLimit` are both functions. `makeProvider` still returns
an `InferenceProvider`, and a consumer narrows it with `canDecide`.

### Why Jev's request shape

The request is a `state` plus `questions` keyed by id. Each question is `{ type: "choice",
instructions, criteria }`, and `criteria` maps an option id to what choosing it means. Each answer
is `{ choice, probabilities, confidence }`. That is the shape of Jev's System One API. A `jev`
provider can then forward a request without translating it, and a local implementation can read
the same fields to build its prompt. Inventing a shape of our own would have meant a mapping layer
in the hosted provider, with nothing gained for the local one. Keying questions by id lets one
`state` carry several questions, which is how manni asks every rule of a turn at once. `stateLimit`
tells a consumer how much state fits before it sends any.

### Validation

`decide` rejects with an `InferenceError` when there are no questions, a question or criterion id
is `""`, a question's `type` is not `"choice"`, or a question has fewer than two criteria. These are
caller errors, like the other `InferenceError`s, and no provider can answer them. The check lives in
one function in `src/providers/decide.ts` that every decision provider calls.

### The normalization rule

Every decision provider passes its raw scores through one shared helper, `normalizeDecision`, in
`src/providers/decide.ts`:

- Weights must be finite and non-negative, and must name only the question's options. Anything else
  is an `InferenceError`. An option with no weight gets 0.
- Probabilities are the weights divided by their sum, so they sum to 1 up to rounding. When every
  weight is 0 they are uniform.
- `choice` is the most probable option, and a tie goes to the option listed first in `criteria`.
- `confidence` is `probabilities[choice]`, always.

A llama.cpp provider's option-token probabilities don't sum to 1, because other tokens take the
rest. Renormalizing over the options is what makes them comparable with Jev's. Putting the rule in
one place stops each provider from drifting into its own.

### The mock

`MockProvider` implements `DecisionProvider`. `mockDecisions` (on `ProviderSpec`, or `decisions` in
the new third constructor argument) scripts answers per question id, either as an option id, which
gets probability 1, or as weights. It also takes a function of the question id, question and state.
An unscripted question gets uniform probabilities, so the first option wins with the lowest
confidence the question allows. That way an unscripted mock never looks like a confident answer,
which matches how an unscripted `completeJSON` answers `{}`. `stateLimit()` reports
`mockStateLimit`, 8192 by default, which matches the local provider's smallest context.

### Consequences

- Good, because the base contract, `JudgeRun` and the cache format are unchanged, and no consumer
  needs to change.
- Good, because a provider without real probabilities simply doesn't implement `decide`, so it
  can't report confidence it lacks.
- Good, because confidence means the same thing on every provider.
- Neutral, because `decide` has no errored-run wrapper like `completeValidatedJSON`. A consumer
  catches the rejection itself. Decisions don't validate a schema, so there is nothing to retry.
- Bad, because a consumer has to check `canDecide` before it calls `decide`. That is the price of
  keeping the capability optional.

### Confirmation

`test/unit/decide.test.ts` pins `canDecide` both ways, each validation error, the normalization rule
(sum, ties, uniform zeros, bad weights), and the mock's defaults, scripts and `ProviderSpec` fields.
`scripts/check-docs-exports.mjs` and `scripts/check-error-coverage.mjs` hold the reference pages to
the new exports and messages.

### Commit type

`feat`. It adds exports, a `ProviderSpec` field pair and an optional constructor argument. Nothing
is removed or renamed, and `MockProvider` still satisfies `InferenceProvider`, so it is not
breaking.

## Pros and Cons of the Options

### Widen `InferenceProvider` with a required `decide`

- Good, because every provider has the same surface.
- Bad, because the Anthropic, OpenAI and Claude CLI providers would have to fake probabilities or
  throw. Either way the type would promise something they can't do.
- Bad, because a third-party `InferenceProvider` stops compiling. That is a breaking change for
  every consumer.

### An enum schema through `completeJSON`

- Good, because it needs no new surface at all.
- Bad, because a sampled answer is not a distribution, and a confidence field is generated text, not
  a measurement. Consumers would set thresholds on numbers that mean nothing.

### An optional `DecisionProvider` capability (chosen)

- Good, because providers that can decide do, and the rest stay as they are.
- Good, because the shape maps one-to-one onto Jev's API.
- Bad, because there is a capability check at each call site.
