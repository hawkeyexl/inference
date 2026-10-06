---
status: "accepted"
date: 2026-10-06
decision-makers: [hawkeyexl]
---

# Answer many items with schema-valid JSON over one shared prefix, evaluating the prefix once on local models

## Context and Problem Statement

manni's tracevals judges one agent turn against N rules. It wants each rule answered as a
structured object, such as `{"followed": 0-100, "not-followed": 0-100, "not-applicable": 0-100}`,
one object per rule. A multiple-choice letter is not enough. The turn is long, often thousands of
tokens, and the same for every rule. Each rule adds a sentence or two.

`completeJSON` answers one `(system, user)` pair. Called once per rule, every call evaluates the
whole turn again. On a local model that is most of the cost: on `qwen3.5-4b`, one rule over a
3700-token turn takes about 730 ms, and 30 rules take about 22 s. `decide()` (ADR 01013, 01016)
already evaluates a shared state once, but it answers with probabilities over lettered options, not
with an object.

How should the library answer N structured questions over one long prefix, without widening the
contract every provider pays for?

## Decision Drivers

- The base contract stays `(system, user, schema, temperature) -> JSON`. No provider has to change.
- One entry point serves every provider, so a consumer does not branch on the provider.
- A failed item is recorded in its place, never dropped and never coerced (the errored-run
  invariant in CLAUDE.md). The call throws only when nothing can be answered.
- On a local model the prefix is paid for once, on attention and hybrid models alike.
- Inference stays in the worker process (ADR 01012), and context is sized to the work and refused
  on overflow (ADR 01011).
- Consumers test offline, so `MockProvider` must answer it.

## Considered Options

- N independent `completeJSON` calls, left to the consumer
- One call whose schema returns every item's answer in one object
- A top-level `completeJSONShared`, with a native path on llama-cpp and a fallback elsewhere

## Decision Outcome

Chosen option: "A top-level `completeJSONShared`", because it costs one prefix evaluation where a
model can share one and costs nothing new where it cannot.

### Interface

```ts
function completeJSONShared(provider: InferenceProvider, req: SharedJSONRequest): Promise<SharedJSONResponse>;
interface SharedJSONRequest {
  system: string; shared: string; items: string[]; schema: Record<string, unknown>;
  temperature?: number;  // default 0
  concurrency?: number;  // default 8
}
type SharedJSONAnswer = { json: unknown } | { error: string };
interface SharedJSONResponse {
  answers: SharedJSONAnswer[]; usage?: TokenUsage; reuse?: "erase" | "checkpoint" | "reevaluate";
}
```

Item `i` is asked with the user turn `shared + items[i]`, verbatim. The shared part comes first, so
every item's turn opens with the same text.

`completeJSONShared` checks for a `completeJSONShared` method on the provider. Only
`LlamaCppProvider` has one. The interface that names it stays internal, as the method's only job
is to be this function's native path. Every answer is validated against `schema` here, the native
ones included, because a grammar shapes the output but does not check every keyword.

### The fallback

A provider without the method gets one `completeValidatedJSON` call per item, with its one retry,
at most `concurrency` in flight. Each run's `error` becomes that item's `{ error }`. Usage is summed
over the runs that report it. `MockProvider` takes this path, so item `i` gets the `i`th scripted
response when every response is valid. Anthropic and OpenAI could cache a prompt prefix on their
side, but that needs a request shape this contract does not have. They pay for N whole prompts, as
a consumer's own loop would.

### The local path

It reuses the machinery of ADR 01016. `decideOn`'s loop is now `onSharedStart` in
`llama-worker.ts`. That loop renders every prompt, evaluates the tokens they share once, takes a
checkpoint when the sequence needs one, and runs a callback on each prompt's tail. Between prompts
it erases back to the shared start and reads `reuse` from the token meter. `decideOn` probes in
the callback, and the new `completeSharedOn` generates there.

Each turn is rendered in the model's chat template with thinking off and an empty opened answer.
The tail is evaluated and the answer generated with `LlamaContextSequence.evaluate`, under a
`createGrammarForJsonSchema` grammar made once per request. Generation stops at the first point
where the text is a complete JSON object or array, with the brace of ADR 01010 restored. It also
stops when the model ends its turn, or at `maxTokens`. The grammar would allow trailing whitespace
after the value, so the first stop saves those tokens.

The provider sizes one context with `contextFor`, using the system prompt with the schema restated
and the longest item's turn. With `maxTokens` unset, each item may use the room left after that
prompt, as for `completeJSON`. A truncated, unparseable or invalid answer is that item's error. A
thrown generation error is too, and the next item still starts from the shared start.

A failed item is not retried. At temperature 0 the same prefix produces the same tokens, so a
retry would spend a generation to fail the same way. A worker crash retries the whole request on
the next backend with a fresh session, as `prompt` and `decide` do. The model host forwards it as
one queued job, `op: "completeJSONShared"`.

`reuse` is on `SharedJSONResponse`, unlike `DecideResponse`. A consumer sizing its batches wants to
know when a model re-evaluated the prefix, and the field is absent on every other provider.

Measured on an RTX 4090 with CUDA: 30 rules over a turn of about 3700 tokens, with a three-integer
schema, after the weights load.

| Model | `reuse` | 30 items | Per item | One item alone |
|---|---|---|---|---|
| `qwen3.5-4b` | `checkpoint` | 7.0 s | about 230 ms | about 730 ms |
| `granite-4.1-3b-q2` | `erase` | 3.6 s | about 120 ms | about 800 ms |

### Consequences

- Good, because the turn is evaluated once per call on both attention and hybrid models, three to
  six times faster for 30 rules than one call per rule.
- Good, because the base contract, `JudgeRun` and the cache format are unchanged, and a consumer
  calls one function whatever the provider.
- Good, because each item fails alone, and in its place, so a rule that cannot be judged is
  visible.
- Neutral, because the native path does not retry a failed item, where the fallback does.
- Bad, because a request whose longest item does not fit the context is refused whole on the local
  provider. On a network provider only that item fails.
- Bad, because `thoughtTokens` does not apply to the local path, since thinking is off.

### Confirmation

`test/unit/llama-worker.test.ts` runs `completeSharedOn` in the real worker against
`test/support/fake-llama-backend.mjs`. Its sequence refuses a context holding two items, and its log
counts each evaluation of the shared prefix. The tests pin one evaluation on the erase and
checkpoint paths and N on the re-evaluation path. They also cover the stop at a complete value,
per-item validation, parse, thrown and `maxTokens` failures, and the fallback from a backend that
crashes mid-generation. `test/unit/complete-shared.test.ts` pins the fallback: order, retries,
usage, the concurrency bound and its default, and the Claude CLI over real processes. It also pins
what the provider hands a session and the context refusal. `test/unit/model-host.test.ts` round-trips
it through the host. `test/integration/live-llama.test.ts`, gated on `INFERENCE_LIVE_LLAMA`,
measures the table above on `qwen3.5-4b`, or on the model in `INFERENCE_LIVE_SHARED_MODEL`.

### Commit type

`feat`. It adds exports and an optional `LlamaSession` member. Nothing is removed or renamed.

## Pros and Cons of the Options

### N independent `completeJSON` calls, left to the consumer

- Good, because it needs nothing new.
- Bad, because every call on a local model evaluates the whole prefix, the cost this exists to
  remove.
- Bad, because every consumer writes the same concurrency pool and error bookkeeping.

### One call whose schema returns every item's answer in one object

- Good, because it is one call on every provider, and the prefix is evaluated once everywhere.
- Bad, because each answer is generated after the previous ones, so it can be anchored by them,
  and the order of the rules changes the scores.
- Bad, because one malformed answer fails, or truncates, all of them, and a long list runs into
  the output limit.
- Bad, because small local models follow a schema with 30 nested objects far less reliably than
  a schema with three integers.

### A top-level `completeJSONShared`, with a native path and a fallback (chosen)

- Good, because each item is answered on its own, from the same prefix, on every provider.
- Good, because the local path reuses the decision machinery rather than a second copy of it.
- Bad, because only the local provider saves the prefix's cost.
