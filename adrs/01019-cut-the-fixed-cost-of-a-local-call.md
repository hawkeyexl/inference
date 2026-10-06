---
status: "accepted"
date: 2026-10-06
decision-makers: [hawkeyexl]
---

# Cut the fixed cost of a local call: read the top 40 tokens for a decision, reuse one context, and generate compact JSON

## Context and Problem Statement

manni's tracevals asks a local model about one agent turn many times over. A profile of one real
request on `qwen3.5-4b`, on an RTX 4090 with CUDA, timed every stage. The request was 36 questions
over a state of about 900 tokens.

A decision probe took about 82 ms a question. About 58 ms of that was spent reading the
next-token distribution, because node-llama-cpp builds it over the whole vocabulary, a six-figure
number of entries, for the provider to read a few letters from it. ADR 01016 recorded this as
"fast enough"; at 36 questions a call it was most of the call.

Every call also created a new 8192-token context, which took 165 to 220 ms. Opening its chat
session resolved the model's chat template again, about 120 ms more. And sizing the context counted
the system prompt and each of the 36 prompts in a round trip of its own to the worker, about 30 ms.

A shared-prefix request with the reasoning first, 36 items, spent 97% of its time decoding, about
123 tokens an item at about 111 tokens a second. node-llama-cpp's JSON-schema grammar allows a
newline and indentation before every property and a space after every colon and comma, and the
model took them up.

No contract changes here: `decide()` answers the same shape, and the sizing rules of ADR 01011
hold. This ADR records the trade-offs a later reader would otherwise re-litigate.

## Decision Drivers

- The probability must stay the model's own, renormalized over the options (ADR 01013, 01016).
- A decision must never come back empty for want of looking.
- Inference stays in the worker process (ADR 01012), and the worker imports only Node builtins.
- A call never gets less context than ADR 01011 sizes for it, and memory follows the work.
- A call never sees another call's tokens.
- The answer must still satisfy the schema, and every value it allowed must still be expressible.

## Considered Options

For the readout:

- Read the whole vocabulary, as before
- Read the 40 most likely tokens, and the whole vocabulary when no letter is among them
- Read the 40 most likely tokens only

For the context:

- A new context per call, as before
- One idle context per model, reused when it fits
- One context per model, grown to the largest call and kept

For the grammar:

- node-llama-cpp's grammar, as before
- A grammar built from the schema by this library
- node-llama-cpp's grammar, with its optional whitespace rewritten out

## Decision Outcome

Chosen options: "Read the 40 most likely tokens, and the whole vocabulary when no letter is among
them", because it keeps the cost of the common case and the answer of the rare one; and "One idle
context per model, reused when it fits", because it removes the per-call setup without letting one
large call pin its memory; and "node-llama-cpp's grammar, with its optional whitespace rewritten
out", because it is the smallest change that leaves the schema's handling where it was.

### The readout

The probe asks node-llama-cpp for `topK: 40` at `temperature: 1`, with `topP: 1` and `minP: 0`.
Temperature 1 leaves the softmax as it is, and `topP: 1` stops node-llama-cpp's default of 0.95 from
truncating the 40 further. The ratio between two letters is the same as in the full distribution,
and `normalizeDecision` renormalizes over the options as before. In the profile, the normalized
letter probabilities matched the full readout to within 2e-6.

A letter outside the 40 weighs 0. When no letter of a question is among them, the worker erases the
question back to the shared start, the way the next question would, and reads it again over the
whole vocabulary. A model that puts its mass elsewhere, such as on an opened thought block, then
gets the same renormalized answer it got before this change, at the price of a second probe.

### One context per model

The worker keeps one idle context per loaded model. A call's session takes it when it holds at
least the size the provider asked for and at most twice it. The worker empties it first with
`clearHistory()`, which drops every token and every checkpoint, so the call starts from nothing, as
it did on a new context. Otherwise the worker disposes the idle context and creates one of exactly
the size asked for. When the session ends, its context becomes the idle one, unless another already
is; then it is disposed. So a model holds at most one idle context, and two concurrent calls each
get their own.

The session reports the size of the context it runs in, and the provider caps a response with no
`maxTokens` at the room that context has left. On a reused context that room can be larger than a
new one would give, and never smaller. A fixed `contextSize` makes every call ask for the same size,
so every call after the first reuses it.

A worker that crashes takes its contexts with it. The replacement worker creates its own, and reuses
that. Unloading a model disposes its idle context first.

The chat template is resolved once per model, on its first session, and passed to every later one.
And the provider's counts for one call reach the worker as one request: the parent collects every
count asked for in one tick and sends them together.

### Compact JSON

node-llama-cpp 3.19's `createGrammarForJsonSchema` takes no option for whitespace, and the generator
under it, which has an `allowNewLines` setting, is not exported. So the worker builds the grammar as
before, rewrites its text with `compactJsonGrammar`, and compiles the result with `createGrammar`,
keeping the stop sequence and whitespace trimming of the original. Both `completeJSON` and
`completeJSONShared` generate under it.

The rewrite relies on how node-llama-cpp spells whitespace: rules named `whitespace-…-rule`, which
become empty; rules named `comma-whitespace-…-rule`, which become a bare comma; and an inline `[ ]?`
after a colon, which is dropped wherever it stands outside a quoted literal or a character class.
Nothing else changes. The root's trailing four newlines, the stop sequence a prompt ends on, stay.

A string property's `maxLength` already reached the grammar, as a bounded repetition of string
characters, and still does. A consumer that caps a reasoning string at 240 characters caps the
tokens it costs.

### Consequences

- Good, because the profiled probe drops from about 82 ms to about 24 ms a question.
- Good, because a decision is never empty: the fallback reads what the old probe read.
- Good, because a call after the first opens its session in well under a millisecond, where creating
  the context and resolving the template took about 140 to 300 ms.
- Good, because a call's counts cost one round trip, not one per prompt.
- Good, because no output token goes to indentation or to a space between JSON tokens.
- Neutral, because an option whose letter is not among the 40 gets probability 0 where it used to
  get a tiny one. On a question with 26 options, a model can spread its mass past 40 tokens; the
  options it gives the least are then 0.
- Neutral, because an idle context stays allocated between calls. That is the memory the next call
  would allocate anyway, and the model host's keep-alive already holds the weights longer.
- Bad, because a question that falls back costs two probes and one erase.
- Bad, because a call can run in a context up to twice the size it needs, so peak memory can be up
  to twice what ADR 01011 sizes for one call.
- Bad, because the rewrite depends on node-llama-cpp's rule names. A release that renames them
  leaves the whitespace in, which costs tokens and breaks nothing; the grammar tests fail on it.

### Confirmation

`test/unit/llama-worker.test.ts` runs `decideOn` in the real worker against
`test/support/fake-llama-backend.mjs`, whose probe returns only the `topK` most likely tokens. It
checks that a letter outside the 40 weighs 0 while the letters present sum to 1, and that a question
with no letter among them is read again over the whole vocabulary. The fixture's contexts log each
creation, and the suite checks that a second call reuses the first's context, that a call needing
more creates a larger one, that one more than twice too large is not kept, that a reused context
starts empty, that a replacement worker creates its own after a crash, and that a call's counts are
one request. `test/unit/llama-grammar.test.ts` rewrites the grammar node-llama-cpp generates and
checks the text, then compiles it with the real binding on the CPU and asks llama.cpp's grammar
engine what it accepts: compact JSON, not spaced or pretty-printed JSON, and no string past its
`maxLength`.

### Commit type

`perf`. No interface or result shape changes.

## Pros and Cons of the Options

### Read the whole vocabulary, as before

- Good, because every letter gets its exact probability.
- Bad, because building the distribution is most of a question's cost.

### Read the 40 most likely tokens, and the whole vocabulary when no letter is among them (chosen)

- Good, because the common case reads 40 entries.
- Good, because the rare case answers as before.
- Bad, because the rare case costs a second probe.

### Read the 40 most likely tokens only

- Good, because every question costs one small probe.
- Bad, because a question whose letters all fall outside the 40 has no answer at all.

### A new context per call, as before

- Good, because each call's memory is exactly what ADR 01011 sizes.
- Bad, because every call pays for the context and the chat template again.

### One idle context per model, reused when it fits (chosen)

- Good, because the common case, calls of similar size, creates one context in all.
- Good, because a context more than twice what a call needs is replaced, so memory still follows
  the work.
- Bad, because a call can run in up to twice the context it needs.

### One context per model, grown to the largest call and kept

- Good, because no call after the largest ever creates a context.
- Bad, because one long prompt pins its context for as long as the model stays loaded, which is the
  memory problem ADR 01011 fixed.

### node-llama-cpp's grammar, as before

- Good, because it needs no code.
- Bad, because a model that pretty-prints pays for every newline and indent.

### A grammar built from the schema by this library

- Good, because it would control every byte the model may write.
- Bad, because it reimplements node-llama-cpp's whole schema support, `$ref`, `oneOf`, formats and
  lengths, and the two would drift.

### node-llama-cpp's grammar, with its optional whitespace rewritten out (chosen)

- Good, because the schema's handling stays node-llama-cpp's.
- Bad, because it reads node-llama-cpp's rule names, which are not a public interface.
