# @hawkeyexl/inference

Shared LLM inference layer for the docs-as-tests toolchain: schema-constrained completion across
Anthropic, OpenAI-compatible, and Claude CLI providers, with result caching, cost accounting, and
an LLM-as-judge ensemble on top.

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

- **Completion** — the provider contract, four providers, a content-addressed cache, a price table,
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
| `mock` | scripted responses | — | synthetic |

```ts
interface ProviderSpec {
  provider: "anthropic" | "openai" | "claude-cli" | "mock";
  model?: string | null;      // null/undefined -> per-provider default
  apiKeyEnv?: string | null;  // default ANTHROPIC_API_KEY / OPENAI_API_KEY
  baseUrl?: string;           // openai only, default https://api.openai.com/v1
  command?: string;           // claude-cli only, default "claude"
  timeoutMs?: number;         // claude-cli only, default 180000
  pricing?: Pricing;          // override the built-in table
  anthropic?: AnthropicProviderOptions;   // e.g. toolName, maxTokens
  openai?: OpenAICompatProviderOptions;   // e.g. schemaName
  exec?: ExecFn;              // test seam for claude-cli
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

**Providers** — `makeProvider`, `resolveProviderIdentity`, `DEFAULT_MODELS`,
`DEFAULT_OPENAI_BASE_URL`, `AnthropicProvider`, `OpenAICompatProvider`, `ClaudeCliProvider`,
`MockProvider`, `mockVerdict`, `extractJson`, `toStrictSchema`, `stripNulls`, `realExec`

**Completion** — `completeValidatedJSON`, `validatorFor`

**Cache** — `JsonCache`, `buildCacheKey`, `sha256`

**Cost** — `pricingFor`, `costOfUsage`, `costOfRuns`, `PRICE_TABLE`

**Judge** — `judge`, `runEnsemble`, `computeConsensus`, `zoneFor`, `VERDICT_SCHEMA`,
`DEFAULT_ZONES`

**Errors** — `InferenceError` (operational failures: missing key, unknown provider)

Types: `InferenceProvider`, `ProviderSpec`, `ProviderName`, `CompleteJSONRequest`,
`CompleteJSONResponse`, `InferenceRun`, `TokenUsage`, `Pricing`, `JudgeRun`, `JudgeVerdict`,
`ConsensusResult`, `Match`, `Zone`, `ZoneThresholds`, `EnsembleOptions`, `ExecFn`, `ExecResult`,
`ExecOptions`, `MockResponse`.

## Design decisions

Recorded as ADRs in [adrs/](adrs):

- [01000](adrs/01000-library-owned-provider-spec.md) — a library-owned `ProviderSpec`, not consumer
  config objects
- [01001](adrs/01001-single-entry-point-and-canonical-verdict-schema.md) — one entry point; a
  canonical verdict schema with a per-consumer override seam
- [01002](adrs/01002-best-of-merge-of-three-forks.md) — which fork won for each merged file, so the
  losing variants are not reintroduced

## License

MIT
