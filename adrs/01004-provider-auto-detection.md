---
status: "accepted"
date: 2026-08-03
decision-makers: [hawkeyexl]
---

# Detect an available provider when none is specified, ending at the local model

## Context and Problem Statement

`ProviderSpec.provider` was required and had no fallback. ADR 01000 makes every consumer map its own
config into a `ProviderSpec`, so an unset field is a realistic shape for a bug — and what it
produced was poor:

```
makeProvider({})            → InferenceError: Unknown provider "undefined".
resolveProviderIdentity({}) → { provider: undefined, model: "unknown" }   // did NOT throw
```

The second is the worse half. That function exists to mint cache keys *without* constructing a
provider, so a malformed spec silently keyed a cache on `undefined`/`"unknown"` — and two
differently-malformed specs collided on that same key rather than failing.

ADR 01003 changed the calculus: with `llama-cpp` needing no API key, no daemon and no account,
there is now always *something* a machine can run. "No provider specified" can become a working
default instead of an error.

## Decision Drivers

- A cache key must name what actually ran; ADR 01003 established that selectors resolve to
  concrete values before they reach one.
- The consuming tools are eval harnesses. A run whose provider silently changed is a run whose
  verdicts and cache are no longer comparable to the previous one.
- Falling back to a local model can mean downloading gigabytes.
- No network in tests: every probe must be exercisable offline.

## Considered Options

- Detect an available provider, falling back to `llama-cpp`
- Keep `provider` required and only improve the error message
- Default statically to `llama-cpp` when unset

## Decision Outcome

Chosen: **detect**. `ProviderSpec.provider` becomes optional and accepts `"auto"`; omitting it is
identical to `"auto"`. Priority is **`anthropic` → `openai` → `claude-cli` → `llama-cpp`**: the
metered APIs first (they report token usage, so cost accounting stays honest), then local Claude
auth, then the free local model as the floor.

**`mock` is never auto-selected.** It answers `{ json: {} }` unless scripted, which would sail
through as a non-error result — the exact opposite of the "an errored run is recorded, never
coerced" invariant the eval tools are built on. It must always be asked for by name.

### Probes reuse the seams that already exist

| Provider | Available when |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` is non-empty |
| `openai` | `OPENAI_API_KEY` is non-empty **or** `baseUrl` is set (keyless local server — the rule `OpenAICompatProvider`'s constructor already applies) |
| `claude-cli` | `spec.exec ?? realExec` runs `[command, "--version"]` and exits 0 |
| `llama-cpp` | `LlamaRuntime.getMemoryBudgetBytes()` resolves |

**Probing stops at the first hit**, and this matters more than it looks: the probes get an order of
magnitude more expensive down the list. Measured, an env read is microseconds, the CLI spawn ~150ms
and the llama binding ~850ms — and that last one initialises the llama backend and allocates GPU
context. Probing eagerly cost ~987ms to select `anthropic` off an environment variable, on every
construction, and touched the GPU for a provider that was never used. `availableProviders` must
still probe everything, because reporting the full list is its whole job.

**Detection reads the default key variables and ignores a custom `apiKeyEnv`.** That field is
shared by both API providers and detection only runs when none was named, so a custom name cannot
say which provider it belongs to. Honouring it let one custom variable satisfy both probes, and
`anthropic` then won on priority — so a spec carrying an OpenAI key under a custom name selected
`anthropic` and 401'd at call time. A custom `apiKeyEnv` still applies in full once a provider is
named; it just cannot be what chooses one.

The CLI probe is memoised **per command**, not globally: a spec naming a different executable asks
a different question, and a single memo made a fallback to an absolute path inherit the bare
command's failure.

No new test seam was needed — environment variables, `ExecFn` and `LlamaRuntime` cover all four, so
the entire matrix runs offline with no network, subprocess or weights. The llama-cpp probe is
deliberately the same call the `auto` *model* selector already makes, so selecting it costs nothing
extra. An empty-string key counts as absent; treating it as present just defers a 401.

Environment probes are not memoised: they are free, and a consumer may legitimately set a key
part-way through a process.

### Async only, and the synchronous path now throws

Detection is async because two probes are, so it follows the rule ADR 01003 set for model
selectors: `resolveProviderIdentityAsync`/`makeProviderAsync` resolve, and the synchronous twins
throw an `InferenceError` naming them.

That throw is also the fix for the garbage return above. It is a **behaviour change on a public
function**, shipped as a `fix:` rather than a `BREAKING CHANGE:` because the old value was unusable
by construction: no consumer can act on `provider: undefined`, and anything that persisted it built
a cache key guaranteed to collide with every other malformed spec.

`ProviderIdentity.provider` is narrowed from `string` to `ProviderName` — a narrowing is safe for
readers, and it makes "an identity is always concrete" a compile-time guarantee rather than a
convention. It also caught a real bug during implementation: `makeProviderAsync` was threading only
the resolved *model* into `makeProvider`, leaving a detected provider `undefined`.

### Two warnings, each once per process

Following `resetTemperatureWarning` in `judge/ensemble.ts`, with a matching
`resetProviderDetectionWarning()` seam.

1. On any auto-selection: name the chosen provider. Reproducibility demands the choice be visible —
   an environment variable moving between runs silently changes what "the same" eval measured.
2. When `llama-cpp` is selected and its weights are **not** already on disk: name the model and its
   download size, *before* the download starts rather than after a CI job has stalled on it.

Warning 2 needs to know whether the blob is present, which `llama-clean.ts` could already determine.
That matching moved into `llama-models.ts` as `isModelDownloaded`/`matchesModelBlob`/`blobNameFor`
and both call sites now share it. A `.ipull` partial counts as *not* downloaded — it cannot be
loaded, so calling it present would skip the warning and then stall on a download anyway.

### The aggregate error

When nothing is available, say what was tried and why each failed, rather than naming a provider the
caller never chose:

```
No inference provider is available. Tried:
  anthropic  — ANTHROPIC_API_KEY is not set
  openai     — OPENAI_API_KEY is not set and no baseUrl was given
  claude-cli — could not run `claude` (is the Claude CLI installed?)
  llama-cpp  — node-llama-cpp is not installed (npm i node-llama-cpp)
Pass an explicit `provider`, set one of the keys above, or install node-llama-cpp.
```

### Consequences

- Good, because the library now works out of the box on a machine with no API keys at all.
- Good, because a malformed spec fails loudly instead of poisoning a cache.
- Good, because `availableProviders()` gives consumers a supported way to show a picker or explain
  a fallback, instead of re-implementing these probes.
- Bad, because omitting `provider` was previously a TypeScript compile error and no longer is — a
  genuinely forgotten field now selects something instead of failing to build. The selection
  warning is the mitigation, and an explicit `provider` remains the way to pin behaviour.
- Bad, because detection reads ambient environment state, so the same code can resolve differently
  on two machines. This is the point of the feature, but it means a cache key must record the
  resolved provider — which it does.

### Confirmation

`test/unit/detect.test.ts` pins the order, each provider winning in turn, `mock` never being
selected, keyless-`baseUrl` openai, custom `apiKeyEnv`, empty-string keys, the memoised CLI probe
(including a timeout counting as unavailable), the aggregate error naming all four reasons, both
warnings firing exactly once, and the synchronous forms throwing. It also asserts
`makeProviderAsync(spec)` and `resolveProviderIdentityAsync(spec)` agree on both halves of the
identity — the regression that caught the threading bug. `test/unit/llama-downloaded.test.ts`
covers `isModelDownloaded` against a real temp directory, including partials, split parts and
subdirectories. All of it runs offline.

## Pros and Cons of the Options

### Detect an available provider

- Good, because it uses what the machine actually has rather than guessing.
- Good, because the fallback floor needs no key, account or daemon.
- Bad, because it is async, which forces the two-factory split — already paid for by ADR 01003.

### Keep `provider` required, improve the error only

- Good, because behaviour stays fully explicit and reproducible.
- Bad, because it leaves the `resolveProviderIdentity` cache-key hazard unfixed, and every consumer
  re-implements "which provider can I use?" against the same env vars.

### Default statically to `llama-cpp`

- Good, because it is trivial and deterministic.
- Bad, because a machine with `ANTHROPIC_API_KEY` set would silently judge with a 2.6 GB local
  model, and the first run would download gigabytes no one asked for.
