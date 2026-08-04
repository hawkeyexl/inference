# @hawkeyexl/inference

Shared LLM inference layer for the docs-as-tests toolchain: schema-constrained completion across
Anthropic, OpenAI-compatible, Claude CLI, and in-process local (llama.cpp) providers, with result
caching, cost accounting, and an LLM-as-judge ensemble on top.

Extracted from three projects that had each grown their own copy —
[docevals](https://github.com/hawkeyexl/docevals), [dockg](https://github.com/hawkeyexl/dockg), and
[agentevals](https://github.com/hawkeyexl/agentevals) — so a provider fix lands once instead of
three times.

**📖 [Documentation](https://hawkeyexl.github.io/inference/)**

## Install

```bash
npm install @hawkeyexl/inference
```

Requires Node 24+. Three runtime dependencies, plus one optional peer dependency for local models.

**ESM only.** The `exports` map has no `require` condition, so
`require("@hawkeyexl/inference")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. From CommonJS, use
`await import("@hawkeyexl/inference")`.

## What it does

Every consumer wants the same narrow thing: **send a system prompt, a user prompt, and a JSON
Schema; get back JSON that validates against that schema, or a recorded error.**

```ts
(system, user, schema, temperature) -> JSON
```

**No streaming, no multi-turn, no tool loops.** If you need a conversation, this is the wrong
package. Widening the provider contract requires an [ADR](adrs).

Two layers, one entry point:

- **Completion** — the provider contract, five providers, a content-addressed cache, a price table,
  and a validate-and-retry wrapper. All that structured extraction needs.
- **Judge** — the canonical verdict schema, an N-run ensemble, consensus math, and confidence-zone
  routing. Built on the completion layer; ignore it if you do not need it.

## Quick start

No API key required — `MockProvider` is exported for exactly this.

```ts
import { MockProvider, completeValidatedJSON } from "@hawkeyexl/inference";

const run = await completeValidatedJSON({
  provider: new MockProvider([{ json: { summary: "Covers authentication." } }]),
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

`completeValidatedJSON` never throws on a model failure and never coerces a bad response. It retries
once, then returns a run with `error` set and `result` absent.

Point it at a real model by swapping the provider — or omit `provider` entirely and let the library
detect one this machine can use, ending at the free local model:

```ts
const provider = await makeProviderAsync({});
```

## Providers

| `provider` | Structured output via | Credential | Reports usage |
|---|---|---|:---:|
| `anthropic` | forced tool call | `ANTHROPIC_API_KEY` | yes |
| `openai` | strict `json_schema`, falls back to `json_object` | `OPENAI_API_KEY` | yes |
| `claude-cli` | schema in the prompt, `--output-format json` | local `claude` auth | **no** |
| `llama-cpp` | GBNF grammar compiled from the schema | — (runs locally) | yes |
| `mock` | scripted responses | — | synthetic |

Usage reporting is the column that decides whether cost accounting works: a provider that reports no
tokens makes a budget gate inert. See
[Choose a provider](https://hawkeyexl.github.io/inference/get-started/choose-a-provider/).

## Documentation

| Track | What it covers |
|---|---|
| [Get started](https://hawkeyexl.github.io/inference/get-started/) | Install, one validated call with no key, choosing a provider |
| [Judge & consensus](https://hawkeyexl.github.io/inference/judge/) | Ensembles, consensus math, confidence zones, caching, budgets |
| [Structured extraction](https://hawkeyexl.github.io/inference/extract/) | One schema-constrained call, honest failures, the subprocess seam |
| [Run models locally](https://hawkeyexl.github.io/inference/local/) | GGUF weights in-process, model selection, managing weights on disk |
| [Keep it working](https://hawkeyexl.github.io/inference/keep-it-working/testing/) | Testing without a network, upgrading without losing a cache |
| [Reference](https://hawkeyexl.github.io/inference/reference/providers/) | Full signatures for every export |

Who the docs serve and why each page exists lives in
[docs/content-strategy/](docs/content-strategy).

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
- [01004](adrs/01004-provider-auto-detection.md) — detect an available provider when none is
  specified, ending at the local model
- [01005](adrs/01005-docset-strategy-and-executable-examples.md) — a CUJ-first documentation set,
  with samples that CI executes

## License

MIT
