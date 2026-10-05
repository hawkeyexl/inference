---
status: "accepted"
date: 2026-10-05
decision-makers: [hawkeyexl]
---

# Decide on local models from the next-token probabilities of option letters, evaluating the shared state once

## Context and Problem Statement

ADR 01013 added decisions as an optional capability: a probability for each of a fixed set of
options, with one normalization rule. Only `MockProvider` implemented it. The llama-cpp provider
holds the model's own scores, so it can report a real probability instead of a generated one.

manni asks every rule of a turn at once: one `state` and many questions. How should the local
provider turn that request into probabilities, and what should it reuse between questions?

## Decision Drivers

- A probability must come from the model's scores, not from text it writes.
- The answer must not depend on how a tokenizer happens to split an option id.
- Qwen3.5, the `balanced` and `quality` tiers, thinks by default. A thought block opened where the
  answer belongs takes the probability mass the options should get.
- Qwen3.5 is a hybrid model, half linear attention. Its context cannot simply drop the last tokens,
  so reuse cannot assume an erase.
- Inference stays in the worker process (ADR 01012), with the CUDA → Vulkan → CPU fallback.
- Context is sized to the work, and an overflow is refused, not truncated (ADR 01011).

## Considered Options

- Generate a JSON answer with a grammar, and read the sampled token's confidence
- Score each option's full text as a continuation
- Letter the options, and read the next-token probability of each letter

## Decision Outcome

Chosen option: "Letter the options, and read the next-token probability of each letter", because
one forward pass per question gives a distribution over every option at once.

### The prompt

A fixed system prompt says to answer with the letter of the option that fits. The user turn is the
state, then the question's `instructions`, then the options lettered A, B, C in `criteria` order with
their meanings. The state is the string as given, or indented JSON for an object or array. The
model's own chat template wraps the turn, and the assistant's turn opens with `Answer:`. The token
after it is the answer. A question has at most 26 options.

### The letter tokens

For each letter the worker tokenizes the bare letter and the letter after a space, and keeps each
spelling that is one token. On Qwen3.5 and Granite 4.1, `A` and ` A` are two distinct single tokens.
The letter's weight is the sum of their probabilities. The weights go through `normalizeDecision`
unchanged, as ADR 01013 requires.

The probabilities come from `controlledEvaluate` at temperature 0. llama.cpp then samples greedily,
so the softmax covers the whole vocabulary, untruncated by top-k or top-p.

### Thinking off

The worker swaps the session's chat wrapper for its no-thinking form. Qwen3 and Qwen3.5 use
`QwenChatWrapper` with `thoughts: "discourage"`, which renders the empty `<think>\n\n</think>\n\n`
block the template itself uses when thinking is disabled. Gemma 4 uses `Gemma4ChatWrapper` with
`reasoning: false`. Any other template is used as it is. The live suite checks that most of the mass
lands on the letters.

### Evaluating the state once

Every prompt is rendered whole and tokenized, and the tokens all of them share are evaluated once.
Comparing token arrays, not strings, keeps the split exact wherever the tokenizer merges across it.
Each question then evaluates only its own tail and reads the probabilities. Before the next one, the
worker erases the tail with `eraseContextTokenRanges`. When the sequence `needsCheckpoints`, it takes
a checkpoint after the shared tokens first.

node-llama-cpp decides how the erase is done. It removes the tokens when the model allows it,
restores the checkpoint when it does not, and evaluates the shared tokens again when neither works.
The worker does not guess which one ran. It reads the sequence's token meter around the erase, and
any input tokens it counts mean a re-evaluation. The runtime reports the path as `reuse` on
`LlamaDecideResult`: `"erase"`, `"checkpoint"` or `"reevaluate"`, absent for a single question.
`reuse` stays off `DecideResponse`, because it describes the runtime, not the answer.

Measured on an RTX 4090 with CUDA, three questions over a short state:

| Model | `reuse` | Per question |
|---|---|---|
| `qwen3.5-4b` | `checkpoint` | about 160 ms |
| `granite-4.1-3b-q2` | `erase` | about 200 ms |
| `qwen3.5-4b`, CPU | `checkpoint` | about 11 s |

### Where it runs

The algorithm is `decideOn` in `llama-worker.ts`, over a small `DecideSequence` interface. The real
backend adapts a node-llama-cpp context sequence to it, and the test fixture adapts a simulated one.
The worker runs it for a new `decide` request. The host forwards that request the way it forwards
`prompt`, so a crash retries on the next backend with a fresh session. The in-process fallback runs
the same function. `LlamaSession` gains an optional `decide`, so a runtime written before it still
satisfies the seam. A provider whose sessions lack it rejects `decide()` with an `InferenceError`.

### Context and `stateLimit`

The context is sized by the same `contextFor` as `completeJSON`. The user prompt is the longest
question's, and the response reserve is 8 tokens for the answer, not `maxTokens`. `stateLimit()`
returns the training context, or `contextSize` when set, less the system prompt, the 512-token
template overhead, the 8 answer tokens, and 128 tokens for the provider's own framing. That is the
inequality `contextFor` refuses by, so a request within the limit is never refused.

### Consequences

- Good, because confidence is the model's own probability, renormalized over the options.
- Good, because each question costs one forward pass over its own tokens, and the state is paid
  for once on every model that can erase or checkpoint.
- Good, because the reuse path is measured, so a model that silently re-evaluates shows up.
- Neutral, because each probe builds the distribution over the whole vocabulary, a six-figure
  number of entries, to read a few of them. It is fast enough at the numbers above.
- Bad, because a template the worker does not know may still open a thought block. The letters then
  get little mass, and the confidence is renormalized from a small remainder.
- Bad, because the options are capped at 26.

### Confirmation

`test/unit/llama-decide.test.ts` pins the prompt, the lettering, the mapping back to option ids, the
context sizing and `stateLimit`, through a fake `LlamaRuntime`. `test/unit/llama-worker.test.ts`
runs `decideOn` in the real worker against `test/support/fake-llama-backend.mjs`, whose simulated
sequence refuses a context holding two questions at once. It covers each `reuse` path and the
fallback from a backend that crashes mid-decision. `test/integration/live-llama.test.ts`, gated on
`INFERENCE_LIVE_LLAMA`, checks real answers, the letter mass and the reuse path on `qwen3.5-4b`, or
on the model in `INFERENCE_LIVE_DECIDE_MODEL`.

### Commit type

`feat`. `LlamaCppProvider` gains `decide` and `stateLimit`, the seam gains optional members and new
types, and nothing is removed or renamed.

## Pros and Cons of the Options

### Generate a JSON answer, and read the sampled token's confidence

- Good, because it reuses the `completeJSON` path.
- Bad, because the confidence is for one sampled token, not a distribution over the options.
- Bad, because option ids that share a first token, such as `yes` and `yes_but`, cannot be told apart.

### Score each option's full text as a continuation

- Good, because it needs no lettering and no cap on options.
- Bad, because it takes one pass per option, not per question.
- Bad, because longer option texts score lower, and correcting for length is a second rule
  providers would drift on.

### Letter the options, and read the next-token probability of each letter (chosen)

- Good, because one pass per question scores every option.
- Good, because a letter is one token on every catalog model, whatever the option ids are.
- Bad, because a question has at most 26 options.
