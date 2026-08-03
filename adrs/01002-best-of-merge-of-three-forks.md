---
status: "accepted"
date: 2026-08-03
decision-makers: [hawkeyexl]
---

# Best-of merge of three drifted forks

## Context and Problem Statement

docevals' `src/judge/`, dockg's `src/llm/`, and agentevals' `src/judge/` were forks of one original
that then drifted independently. Several files exist in two or three variants where each variant
holds a fix the others lack, so "take the newest" and "take the biggest" both silently discard
working fixes. This ADR records which variant won each contest, and why, so a later reader porting
from one of the origin repos does not reintroduce a regression that looks like a restoration.

## Decision Drivers

- Each fix was written in response to a real failure; discarding one re-opens that failure.
- Windows is a first-class development platform for these tools.
- The losing variants remain in three repos' git history and will keep being read.

## Considered Options

- Take one project's copy wholesale as the base
- Merge per file, choosing the variant with the fix
- Rewrite from scratch against the union of behaviors

## Decision Outcome

Chosen option: **merge per file**. Per-file resolutions:

| File | Winner | Why |
|---|---|---|
| `exec.ts` | docevals + dockg | docevals added `opts.input` and conditional `stdio[0]` for stdin piping; dockg added `setEncoding("utf8")` so multi-byte UTF-8 straddling a pipe-chunk boundary decodes correctly instead of corrupting nondeterministically. Both are kept. |
| `providers/claude-cli.ts` | docevals | Pipes the prompt through **stdin**. dockg passed it as an argv element, which breaks on the ~32K Windows command-line limit — reachable with ordinary page-sized content. |
| `providers/openai-compat.ts` | dockg | Adds `toStrictSchema` (OpenAI strict mode requires every property in `required`, expresses optionality as a `null` type union, and rejects `minLength`/`uniqueItems`), `stripNulls` to undo it on the way back, and a fallback that also triggers on an opaque `HTTP 400` from gateways that reject `response_format` without a parseable error body. |
| `cache.ts` | docevals / agentevals | `set` catches write failures, warns once, and continues. dockg's threw, so a read-only workspace aborted a run whose inference had already succeeded and been billed. |
| `cost.ts` | union | One price table containing every entry across the three copies, including `claude-sonnet-4-6`, which only agentevals knew. |
| `complete.ts` (`singleRun`) | docevals / agentevals | Byte-identical in both; adopted as-is. |
| `consensus.ts`, `zones.ts` | docevals | Only implementation; agentevals imported it from docevals. |

Two behaviors were generalized rather than picked:

- The Anthropic tool name was `record_verdict` in docevals and `record_proposal` in dockg. It is
  now an option defaulting to `record_result`, because the name is prompt surface and the consumer
  owns the domain.
- The prefix match in `pricingFor` now takes the **longest** matching prefix. All three copies used
  `Object.keys(...).find(...)`, which returns an arbitrary insertion-ordered match and would let
  `claude-sonnet-4-5` shadow a more specific future entry.

### Consequences

- Good, because dockg gains the Windows stdin fix and the non-throwing cache without anyone having
  to notice they were missing.
- Good, because docevals and agentevals gain the strict-schema transform and the opaque-400
  fallback, so their OpenAI path works against gateways that previously failed.
- Bad, because three repos' git histories still contain the losing variants, and a well-meaning
  port from one of them would be a regression. That is precisely what this table is for.

### Confirmation

Each merged-in fix has a test that the losing variant would fail:

- `test/unit/claude-cli.test.ts` asserts a 40,000-character prompt reaches `opts.input` and does not
  appear in argv.
- `test/unit/exec.test.ts` round-trips 50,000 multi-byte characters through stdout and 40,000
  characters through stdin.
- `test/unit/providers.test.ts` covers `toStrictSchema` (required-list, null unions, dropped
  keywords, nested recursion, no input mutation) and `stripNulls`.
- `test/unit/cache.test.ts` asserts a failing write warns exactly once and does not throw.
- `test/unit/cost.test.ts` asserts `claude-sonnet-4-6` is priced and pinned variants resolve by
  prefix.

## Pros and Cons of the Options

### Take one project's copy wholesale

- Good, because it is fast and the result is internally consistent.
- Bad, because whichever base is chosen, at least two real fixes are silently dropped — and they
  would only resurface as bug reports from the consumers that already had them.

### Merge per file

- Good, because no working fix is lost.
- Bad, because it takes a careful diff of every file and a record like this one to stay durable.

### Rewrite from scratch

- Bad, because the value here is precisely the accumulated fixes, most of which look like
  incidental detail until the failure they prevent recurs.
