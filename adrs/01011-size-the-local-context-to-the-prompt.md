---
status: "accepted"
date: 2026-10-01
decision-makers: [hawkeyexl]
---

# Size the local model's context to the prompt, not to free memory

## Context and Problem Statement

`LlamaCppProvider` created every context with `model.createContext()` and no size. node-llama-cpp's
default for that is `"auto"`: the largest context free memory allows, up to the size the model was
trained on.

The `fast` tier, `granite-4.1-3b-q2`, was trained on 131072 tokens. On a machine with the RAM to
spare, every call reserved all of it, for a one-field `fill` prompt of about 4000 tokens. Measured on
the same call, `completeJSON` with a one-field schema and a 3977-token prompt:

| Path | Before | After |
|---|---:|---:|
| CPU (`NODE_LLAMA_CPP_GPU=false`), peak process memory | 12.92 GB | 2.85 GB |
| GPU (RTX 4090), peak VRAM, 0.9 GB idle included | 13.1 GB | 3.5 GB |
| Context created | 131072 tokens | 8192 tokens |

The answer was the same either way. Only the reservation changed.

Two consumers paid for it. manni's CI runs `fill` on a 16 GB GitHub runner, and about half of those
runs were OOM-killed. Every user running `fill` locally lost about 11 GB to a context that held a
few thousand tokens.

It also contradicted the tier ladder. `tierForBudget` grants `fast` to a machine with
3.5 × 1.41 GB = 4.9 GB to spare, and the call then took 12.9 GB. The budget was sound; the context
was not bounded by anything the budget could see.

## Decision Drivers

- Memory must follow the work, so a small prompt costs a small context on any machine.
- A long prompt that fits the model must keep working. Some consumers send whole pages.
- A prompt that does not fit must fail loudly. llama.cpp's answer to overflow is to shift tokens out
  of the context, which answers a prompt nobody sent.
- The provider contract stays `(system, user, schema, temperature) -> JSON`. No `JudgeRun` change.
- The `LlamaRuntime` seam stays narrow, and fakes already written against it keep working.

## Considered Options

- Size each context to its prompt, with an 8192-token floor and a `contextSize` override
- A fixed 8192-token context
- node-llama-cpp's adaptive range, `{ max: 8192 }`
- Size each context exactly to its prompt, with no floor
- Estimate the prompt's tokens from its length in characters

## Decision Outcome

Chosen option: "Size each context to its prompt, with an 8192-token floor and a `contextSize`
override", because it is the only option that bounds memory for small prompts, keeps long prompts
working, and refuses an overflow before anything is generated.

For each call, `completeJSON` computes the context it needs once the prompt is known:

```text
needed = tokens(system prompt, schema restated)
       + tokens(user prompt)
       + 512                       chat-template overhead
       + (maxTokens ?? 2048)       room for the response
       + thoughtTokens             the thinking budget, 0 by default
```

Tokens are counted with the model's own tokenizer. Then:

| Setting | Context created | Prompt that does not fit |
|---|---|---|
| `contextSize` unset | `max(8192, needed)`; the floor is lowered to the training context if that is smaller | `InferenceError` when `needed` exceeds the training context |
| `contextSize: N` | `N` | `InferenceError` when `needed` exceeds `N` |

The size is always passed as a number. With a number, node-llama-cpp throws when memory cannot hold
the context, rather than silently shrinking it as `"auto"` and `{ max }` do.

With `maxTokens` unset, the response is capped at the room the context has left after the prompt:
the context created, less the system and user prompts and the 512-token overhead. A bounded context
makes an uncapped response dangerous in a way the old 131072-token context hid. A long answer would
fill it, and node-llama-cpp would shift the prompt out to keep generating. Capped, generation stops
at `maxTokens`, and the error names the context and `llamaCpp.contextSize`.

The 512 tokens of overhead is a margin, not a measurement. granite-4.1-3b-q2's chat template added 12
tokens to the measured call above. Other templates add more, and some prepend a default system
message. The grammar itself takes no context, and the schema restated in the system prompt is
counted with it.

### The seam

`LlamaLoadedModel.createSession` was called before the prompt was known to the runtime, so the size
moves into it: `createSession(systemPrompt, contextSize?)`. The provider always passes the size, and
the real runtime treats an absent one as 8192. The interface gains two members, both optional:

- `trainContextSize`, the ceiling;
- `countTokens(text)`, the model's tokenizer.

`LlamaSession` gains an optional `contextSize`, the size the runtime actually created. It lets a test
read back what the real binding allocated, rather than what was asked for.

They are optional because consumers' fakes implement this interface, and the testing page documents
one. A runtime with no `countTokens` gets the 8192 default and no fit check, which is all a runtime
without a real context can use. Making them required would have broken every fake in every
consuming suite to serve a check that a fake cannot exercise.

### Consequences

- Good, because the `fast` tier's call drops from 12.9 GB to 2.85 GB on CPU, inside the 4.9 GB
  budget that selected it.
- Good, because a prompt that would have been truncated by a context shift is now an
  `InferenceError` naming the counts, recorded as an errored run by `completeValidatedJSON`.
- Good, because the override serves an operator who knows their machine better than a default does.
- Neutral, because the oversize error is retried once like any other thrown error. The retry costs a
  second tokenization and no inference, then the run is recorded as errored.
- Bad, because a fixed `contextSize` below about 2600 tokens cannot hold any prompt unless
  `maxTokens` bounds the response, since the default response reserve is 2048. The error says so.
- Bad, because a caller that called `createSession` directly with one argument now gets the 8192
  default rather than the free-memory maximum. That was the bug, so it is the intended change.

### Confirmation

- `test/unit/llama-cpp.test.ts`, "context sizing", pins the default, the training-context floor, the
  size-up, the response reserve, both oversize errors, the override, and a fake with no tokenizer.
- `test/integration/live-llama.test.ts`, gated on `INFERENCE_LIVE_LLAMA`, loads the real binding and
  granite-4.1-3b-q2, and asserts the context the binding created for a small prompt is at most 8192
  tokens. It also checks that a prompt past the training context is refused before any context is
  created.

### Commit type

This ships as two commits, a `fix:` and a `feat:`. The bounded default and the fit check correct
behaviour that was wrong, so they are a fix. `contextSize` is a new public option, which is a
feature, and the release takes the minor bump that implies. Neither is breaking. The provider
contract, `JudgeRun`, and the cache format are unchanged, and every new seam member is optional.

## Pros and Cons of the Options

### Size to the prompt, 8192 floor, `contextSize` override (chosen)

- Good, because memory is bounded by the work for every prompt that fits the floor.
- Good, because long prompts are sized up instead of refused.
- Good, because an overflow fails before anything is created.
- Bad, because counting tokens costs one tokenization of each prompt per call. That is small next to
  the inference it precedes.

### A fixed 8192-token context

- Good, because it is one line and needs no tokenizer.
- Bad, because a prompt longer than about 5600 tokens, which worked before, would overflow it. It
  would be truncated silently, or refused if a fit check were added.

### node-llama-cpp's adaptive range, `{ max: 8192 }`

- Good, because node-llama-cpp handles the sizing.
- Bad, because under memory pressure it shrinks below `max` without telling the caller, so a prompt
  that fits on one machine overflows on another.
- Bad, because it caps long prompts the same way a fixed size does.

### Size exactly to the prompt, no floor

- Good, because it uses the least memory per call.
- Bad, because the context size then varies on every call, and the saving below 8192 tokens is small
  next to the weights.
- Bad, because a context sized to the last token leaves nothing for a response that runs longer than
  the reserve.

### Estimate tokens from character length

- Good, because it needs no change to the seam.
- Bad, because tokens per character vary by model, language, and content. The model's tokenizer is
  already loaded and gives the exact count.
