---
status: "accepted"
date: 2026-10-06
decision-makers: [hawkeyexl]
---

# Cut the fixed cost of a local call: read the top 40 tokens for a decision

## Context and Problem Statement

manni's tracevals asks a local model about one agent turn many times over. A profile of one real
request on `qwen3.5-4b`, on an RTX 4090 with CUDA, timed every stage. The request was 36 questions
over a state of about 900 tokens.

A decision probe took about 82 ms a question. About 58 ms of that was spent reading the
next-token distribution, because node-llama-cpp builds it over the whole vocabulary, a six-figure
number of entries, for the provider to read a few letters from it. ADR 01016 recorded this as
"fast enough"; at 36 questions a call it was most of the call.

No contract changes here: `decide()` answers the same shape, and the sizing rules of ADR 01011
hold. This ADR records a trade-off a later reader would otherwise re-litigate.

## Decision Drivers

- The probability must stay the model's own, renormalized over the options (ADR 01013, 01016).
- A decision must never come back empty for want of looking.
- Inference stays in the worker process (ADR 01012), and the worker imports only Node builtins.

## Considered Options

- Read the whole vocabulary, as before
- Read the 40 most likely tokens, and the whole vocabulary when no letter is among them
- Read the 40 most likely tokens only

## Decision Outcome

Chosen option: "Read the 40 most likely tokens, and the whole vocabulary when no letter is among
them", because it keeps the cost of the common case and the answer of the rare one.

The probe asks node-llama-cpp for `topK: 40` at `temperature: 1`, with `topP: 1` and `minP: 0`.
Temperature 1 leaves the softmax as it is, and `topP: 1` stops node-llama-cpp's default of 0.95 from
truncating the 40 further. The ratio between two letters is the same as in the full distribution,
and `normalizeDecision` renormalizes over the options as before. In the profile, the normalized
letter probabilities matched the full readout to within 2e-6.

A letter outside the 40 weighs 0. When no letter of a question is among them, the worker erases the
question back to the shared start, the way the next question would, and reads it again over the
whole vocabulary. A model that puts its mass elsewhere, such as on an opened thought block, then
gets the same renormalized answer it got before this change, at the price of a second probe.

### Consequences

- Good, because the profiled probe drops from about 82 ms to about 24 ms a question.
- Good, because a decision is never empty: the fallback reads what the old probe read.
- Neutral, because an option whose letter is not among the 40 gets probability 0 where it used to
  get a tiny one. On a question with 26 options, a model can spread its mass past 40 tokens; the
  options it gives the least are then 0.
- Bad, because a question that falls back costs two probes and one erase.

### Confirmation

`test/unit/llama-worker.test.ts` runs `decideOn` in the real worker against
`test/support/fake-llama-backend.mjs`, whose probe returns only the `topK` most likely tokens. It
checks that a letter outside the 40 weighs 0 while the letters present sum to 1, and that a question
with no letter among them is read again over the whole vocabulary.

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
