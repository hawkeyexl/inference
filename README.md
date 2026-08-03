# @hawkeyexl/inference

Shared LLM inference layer for the docs-as-tests toolchain: schema-constrained completion across
Anthropic, OpenAI-compatible, Claude CLI, and in-process local (llama.cpp) providers, with result
caching, cost accounting, and an LLM-as-judge ensemble on top.

Extracted from three projects that had each grown their own copy —
[docevals](https://github.com/hawkeyexl/docevals), [dockg](https://github.com/hawkeyexl/dockg), and
[agentevals](https://github.com/hawkeyexl/agentevals) — so a provider fix lands once instead of
three times.

## Install

```bash
npm install @hawkeyexl/inference
```

Requires Node 24+. ESM only.

## What it does

Every consumer of this library wants the same narrow thing: **send a system prompt, a user prompt,
and a JSON Schema; get back JSON that validates against that schema, or a recorded error.** No
streaming, no multi-turn, no tool loops.

Two layers, one entry point:

- **Completion** — the provider contract, five providers, a content-addressed cache, a price table,
  and a validate-and-retry wrapper. This is all dockg-style structured extraction needs.
- **Judge** — the canonical verdict schema, an N-run ensemble, consensus math, and confidence-zone
  routing. Built on the completion layer; ignore it if you do not need it.

## Quick start

### Schema-constrained completion

```ts
import { completeValidatedJSON, makeProvider } from "@hawkeyexl/inference";

const provider = makeProvider({ provider: "anthropic", model: "claude-sonnet-4-5" });

const run = await completeValidatedJSON<{ summary: string }>({
  provider,
  system: "You summarize documentation pages.",
  user: pageBody,
  schema: {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
    additionalProperties: false,
  },
});

if (run.error) console.error(run.error);
else console.log(run.result.summary, run.usage);
```

`completeValidatedJSON` never throws on a model failure and never coerces a bad response. It
retries once, then returns a run with `error` set and `result` absent.

### LLM-as-judge

```ts
import { judge, makeProvider } from "@hawkeyexl/inference";

const consensus = await judge({
  provider: makeProvider({ provider: "claude-cli" }),
  system: "You evaluate whether a page satisfies an assertion.",
  user: "# Assertion\nThe page documents authentication.\n\n# Page\n...",
  runs: 3,
});

consensus.verdict;   // "pass" | "fail"   — partial counts as fail
consensus.zone;      // "auto-pass" | "auto-fail" | "human-review"
consensus.agreement; // 0..1 across non-errored runs
```

Only a **unanimous, high-confidence** ensemble auto-resolves. Anything split, low-confidence, or
containing an errored run routes to `human-review` — an errored run can never produce a silent pass.

### Caching

Key composition stays with you, because each consumer has a different notion of what should
invalidate an entry (page body, prompt version, ensemble size, requested fields):

```ts
import { JsonCache, buildCacheKey, runEnsemble, sha256 } from "@hawkeyexl/inference";

const cache = new JsonCache(".mytool/cache", true, "mytool");
const cacheKey = buildCacheKey([
  provider.provider(),
  provider.modelName(),
  `v${MY_PROMPT_VERSION}`,
  `r${runs}`,
  sha256(pageBody),         // pre-hash long parts
]);

const judgeRuns = await runEnsemble({ provider, system, user, runs, cache, cacheKey });
```

Cached runs come back flagged `cached: true`, so `costOfRuns` correctly charges nothing for a
replay. Cache write failures warn once and continue — a read-only workspace must not abort a run
whose inference already succeeded and was already paid for.

### Cost

```ts
import { costOfRuns, pricingFor } from "@hawkeyexl/inference";

const pricing = pricingFor(provider.modelName(), configOverride);
const usd = costOfRuns(judgeRuns, pricing);
```

An unknown model returns `undefined` pricing and costs `0` — **unknown, never a guess**. A
fabricated price is worse than an absent one when a budget gate depends on it.

## Providers

Constructed through `makeProvider(spec)`. The spec is a flat, library-owned shape — map your own
config into it rather than passing your config object (see
[ADR 01000](adrs/01000-library-owned-provider-spec.md)).

| `provider` | Structured output via | Key | Reports usage |
|---|---|---|---|
| `anthropic` | forced tool call | `ANTHROPIC_API_KEY` | yes |
| `openai` | strict `json_schema`, falls back to `json_object` | `OPENAI_API_KEY` | yes |
| `claude-cli` | schema in the prompt, `--output-format json` | local `claude` auth | no |
| `llama-cpp` | GBNF grammar compiled from the schema | — (runs locally) | yes |
| `mock` | scripted responses | — | synthetic |

```ts
interface ProviderSpec {
  provider: "anthropic" | "openai" | "claude-cli" | "llama-cpp" | "mock";
  model?: string | null;      // null/undefined -> per-provider default
  apiKeyEnv?: string | null;  // default ANTHROPIC_API_KEY / OPENAI_API_KEY
  baseUrl?: string;           // openai only, default https://api.openai.com/v1
  command?: string;           // claude-cli only, default "claude"
  timeoutMs?: number;         // claude-cli only, default 180000
  pricing?: Pricing;          // override the built-in table
  anthropic?: AnthropicProviderOptions;   // e.g. toolName, maxTokens
  openai?: OpenAICompatProviderOptions;   // e.g. schemaName
  llamaCpp?: LlamaCppProviderOptions;     // e.g. thoughtTokens, maxTokens
  exec?: ExecFn;              // test seam for claude-cli
  llamaRuntime?: LlamaRuntime;// test seam for llama-cpp
  mockResponses?: MockResponse[];
}
```

`resolveProviderIdentity(spec)` returns `{ provider, model }` **without constructing anything** —
cache keys and pricing need the identity, but a fully-cached run should not require an API key.

Notes on the non-obvious bits:

- **`openai`** targets any `/chat/completions` server (OpenAI, Azure, Ollama, Groq, Together). It
  prefers strict `json_schema`, and `toStrictSchema` rewrites your schema into the strict subset
  (every property in `required`, optionality as a `null` type union, unsupported keywords dropped);
  nulls are stripped back out of the response. If the server rejects `response_format`, it
  permanently falls back to `json_object` with the schema in the prompt. Keyless local servers are
  allowed — only `api.openai.com` requires a key.
- **`claude-cli`** uses your local Claude CLI auth, so no API key. The prompt goes over **stdin**,
  never argv: user content routinely exceeds the ~32K Windows command-line limit.
- **`llama-cpp`** runs GGUF weights in-process. See below — it has its own setup and its own
  factory functions.

## Local models (`llama-cpp`)

Runs GGUF weights in-process via [`node-llama-cpp`](https://node-llama-cpp.withcat.ai): no daemon,
no API key, no per-token cost. Models are downloaded from Hugging Face on first use and cached in
this library's own directory — see [Where models live](#where-models-live-and-clearing-them).

`node-llama-cpp` is an **optional peer dependency**, so it is not installed unless you ask for it:

```bash
npm install node-llama-cpp
```

```ts
import { makeProviderAsync, judge } from "@hawkeyexl/inference";

const provider = await makeProviderAsync({ provider: "llama-cpp" });  // model defaults to "auto"
const consensus = await judge({ provider, system, user, runs: 3 });
```

### Choosing a model

`model` accepts a selector, a curated alias, or any Hugging Face GGUF reference:

| Kind | Example |
|---|---|
| Selector | `auto` (default), `fast`, `balanced`, `quality` |
| Curated alias | `gemma-4-e4b` |
| Hugging Face URI | `hf:unsloth/gemma-4-12B-it-qat-GGUF/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` |
| Local file | `./models/my-model.gguf` |

`auto` sizes the model to the machine, preferring free GPU VRAM and falling back to half of system
RAM. The curated catalog is exported as `LLAMA_MODELS` if you want to inspect sizes and licenses
before triggering a multi-gigabyte download:

| Tier | Alias | Size | IFEval |
|---|---|---|---|
| `fast` | `gemma-4-e2b` | 2.62 GB | 94.6 |
| `balanced` | `gemma-4-e4b` | 4.22 GB | 96.7 |
| `quality` | `gemma-4-12b` | 6.72 GB | 97.2 |
| — | `gemma-4-26b-a4b` | 14.25 GB | MoE, 3.8B active |
| — | `gemma-4-e2b-q2` | 2.19 GB | smallest download |

All entries are unsloth Gemma 4 QAT builds, Apache-2.0 and ungated. QAT is trained for 4-bit
deployment, so it beats a stock Q4 quant of the same model at a smaller file size. Entries pin an
exact blob path rather than a `:QUANT` tag, so a model can never silently re-point underneath a
cache key that already names it.

### Why selectors need `makeProviderAsync`

Resolving `auto` reads GPU memory, which needs an `await`. The synchronous `makeProvider` and
`resolveProviderIdentity` therefore **throw** when given an unresolved selector, rather than
recording the literal `"auto"` as cache-key material — which would let a 2.6 GB and a 6.7 GB model
share cached results, and make one key mean different things on different machines.

Use `makeProviderAsync` / `resolveProviderIdentityAsync`, which return the concrete model the
selector resolved to. Both delegate to the synchronous forms for every other provider, so you can
switch over wholesale. A concrete model (alias, URI, or path) works with either.

### Where models live, and clearing them

Weights go in **this library's own directory** — `~/.hawkeyexl-inference/models`, not
node-llama-cpp's global `~/.node-llama-cpp/models`. That default is shared with node-llama-cpp's
CLI and anything else on the machine using it, so clearing it could destroy models this library
never downloaded. Owning a directory removes the hazard instead of defending against it, and one
copy is still shared across every consumer of this package on the machine.

Override with `INFERENCE_MODELS_DIR`, or per provider:

```ts
makeProviderAsync({ provider: "llama-cpp", llamaCpp: { modelsDirectory: "/mnt/models" } });
```

```ts
import { clearLlamaModels } from "@hawkeyexl/inference";

const { files, freedBytes } = await clearLlamaModels();      // clear everything
await clearLlamaModels({ dryRun: true });                    // report, delete nothing
await clearLlamaModels({ models: ["gemma-4-12b"] });         // just one
await clearLlamaModels({ directory: "/mnt/models" });        // a non-default directory
```

Interrupted `.ipull` partial downloads and every part of a split model are removed too. Only
`.gguf` and `.gguf.ipull` files are ever touched and subdirectories are never walked, so pointing
`directory` somewhere shared still cannot take out unrelated files. Loaded weights are disposed
first, since a memory-mapped model cannot be deleted on Windows.

### Things to know

- **Cost is always 0.** There is no price-table entry, so `pricingFor` returns `undefined` and
  `costOfRuns` yields `0` — the library never guesses a price.
- **Your schema `description`s are not visible to the grammar.** `node-llama-cpp` compiles the
  schema to GBNF without showing it to the model, so the provider restates the schema in the system
  prompt (the same thing `claude-cli` does). Descriptions still steer the model; they just arrive
  via the prompt.
- **`required` is ignored and `additionalProperties` defaults to `false`.** Upstream emits every key
  in `properties`, always. No effect on `VERDICT_SCHEMA`, which requires all its fields; worth
  knowing if your schema has optional ones.
- **Numeric bounds are not grammar-enforced.** A `minimum`/`maximum` violation comes back as
  well-formed JSON and is caught by the normal Ajv validation and retry.
- **Thinking is disabled by default.** A grammar constrains generation from token 0, which cuts a
  thinking model off mid-thought. Set `llamaCpp: { thoughtTokens: 512 }` if you want reasoning
  before the JSON.
- **Weights load once per process** and are shared across providers naming the same model. Call
  `disposeLlamaModels()` to free them in a long-lived process.

## Testing against this library

`MockProvider` is exported for exactly this. No network required:

```ts
import { MockProvider, mockVerdict, runEnsemble } from "@hawkeyexl/inference";

const provider = new MockProvider([mockVerdict("pass", 0.95)]);   // cycles when exhausted
const runs = await runEnsemble({ provider, system, user, runs: 3 });
provider.requests;  // every request seen, in order
```

Script an error with `{ error: "429 rate limited" }` to exercise your failure paths.

## API

Everything exports from the package root.

**Providers** — `makeProvider`, `makeProviderAsync`, `resolveProviderIdentity`,
`resolveProviderIdentityAsync`, `DEFAULT_MODELS`, `DEFAULT_OPENAI_BASE_URL`, `AnthropicProvider`,
`OpenAICompatProvider`, `ClaudeCliProvider`, `LlamaCppProvider`, `MockProvider`, `mockVerdict`,
`extractJson`, `toStrictSchema`, `stripNulls`, `realExec`

**Local models** — `LLAMA_MODELS`, `LLAMA_SELECTORS`, `LLAMA_TIERS`, `aliasForTier`,
`isLlamaSelector`, `resolveLlamaModelRef`, `tierForBudget`, `uriForTier`, `defaultLlamaRuntime`,
`disposeLlamaModels`, `clearLlamaModels`, `defaultLlamaModelsDirectory`

**Completion** — `completeValidatedJSON`, `validatorFor`

**Cache** — `JsonCache`, `buildCacheKey`, `sha256`

**Cost** — `pricingFor`, `costOfUsage`, `costOfRuns`, `PRICE_TABLE`

**Judge** — `judge`, `runEnsemble`, `computeConsensus`, `zoneFor`, `VERDICT_SCHEMA`,
`DEFAULT_ZONES`

**Errors** — `InferenceError` (operational failures: missing key, unknown provider)

Types: `InferenceProvider`, `ProviderSpec`, `ProviderName`, `ProviderIdentity`,
`CompleteJSONRequest`, `CompleteJSONResponse`, `InferenceRun`, `TokenUsage`, `Pricing`, `JudgeRun`,
`JudgeVerdict`, `ConsensusResult`, `Match`, `Zone`, `ZoneThresholds`, `EnsembleOptions`, `ExecFn`,
`ExecResult`, `ExecOptions`, `MockResponse`, `LlamaCppProviderOptions`, `LlamaRuntime`,
`LlamaSession`, `LlamaLoadedModel`, `LlamaPromptOptions`, `LlamaPromptResult`, `LlamaModelEntry`,
`LlamaSelector`, `LlamaTier`, `ClearLlamaModelsOptions`, `ClearLlamaModelsResult`,
`ClearedModelFile`.

## Design decisions

Recorded as ADRs in [adrs/](adrs):

- [01000](adrs/01000-library-owned-provider-spec.md) — a library-owned `ProviderSpec`, not consumer
  config objects
- [01001](adrs/01001-single-entry-point-and-canonical-verdict-schema.md) — one entry point; a
  canonical verdict schema with a per-consumer override seam
- [01002](adrs/01002-best-of-merge-of-three-forks.md) — which fork won for each merged file, so the
  losing variants are not reintroduced
- [01003](adrs/01003-in-process-local-models-via-node-llama-cpp.md) — in-process local models via
  node-llama-cpp, why selectors need an async factory, and why the catalog pins exact blob paths

## License

MIT
