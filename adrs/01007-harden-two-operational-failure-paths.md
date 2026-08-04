---
status: "accepted"
date: 2026-08-04
decision-makers: [hawkeyexl]
---

# Harden two operational failure paths: non-JSON CLI output, and an unsupported Node

## Context and Problem Statement

Writing the [error reference](../docs/src/content/docs/reference/errors.mdx) surfaced two places
where the library fails less clearly than it fails everywhere else. Both were documented as known
behavior at the time rather than fixed, because a documentation change that edits `src/` stops being
reviewable. This is the follow-up.

**1. A bare `SyntaxError` from the Claude CLI.** `ClaudeCliProvider` parsed the
`--output-format json` envelope with an unguarded `JSON.parse`. When the CLI printed something that
was not JSON — an update banner, a login prompt, a proxy interception page — the end user of a
*consuming* CLI saw:

```text
Unexpected token 'W', "Welcome to"... is not valid JSON
```

Every other failure in that file names the culprit and the fix (`Failed to run claude: … (is the
Claude CLI installed?)`, `Claude CLI exited 1: not logged in`). This one path was the exception, and
it is the path a user hits when their CLI session has expired — one of the most common failures
there is.

**2. `engines.node` was advisory and nothing said so.** `package.json` declares `>=24` and the docs
called it a hard requirement, but there was no runtime check anywhere (`grep -rn "process.version"
src/` was empty) and no `engine-strict`. npm treats an `engines` mismatch as an `EBADENGINE`
*warning* — scrolled past in CI, invisible in a transitive install. So an older Node installed
cleanly, ran, and then failed somewhere unrelated with an error that never mentioned Node.

## Decision 1: name the CLI and quote what it printed

```ts
let wrapper: { result?: string };
try {
  wrapper = JSON.parse(result.stdout) as { result?: string };
} catch {
  const excerpt = result.stdout.trim().replace(/\s+/g, " ").slice(0, 200);
  throw new Error(
    `Claude CLI printed non-JSON output (is it logged in?): ${excerpt || "(no output)"}`,
  );
}
```

The excerpt is what makes it actionable — a login prompt is recognisable on sight, and no amount of
prose about "non-JSON output" would be. It is collapsed to one line and capped at 200 characters,
mirroring the `.slice(-300)` on the stderr tail immediately above, so a megabyte of HTML from a
captive-portal redirect cannot become the error message.

`Claude CLI returned no result field` is kept for the case where the envelope *parses* but has no
`result`. Those are different failures — malformed output versus an unexpected schema — and
collapsing them would lose the distinction exactly when it matters.

## Decision 2: warn once, do not refuse to run

**Chosen: a once-per-process `console.warn` on first use**, from `makeProvider` and
`completeValidatedJSON` — the two funnels every consumer passes through, including those that
construct provider classes directly and never touch the factory.

Rejected: **throwing**. The investigation found no technical floor at 24. `tsconfig` targets ES2022,
`src/` imports only `node:crypto`, `node:fs`, `node:os` and `node:path`, the newest globals are
`fetch` (18+) and `structuredClone` (17+), and the strictest dependency floor is `node-llama-cpp` at
`>=20`. **Node 24 is a support policy, not an impossibility** — and a library has no business
refusing to do work it can still do on a consumer's behalf.

Rejected: **throwing at module import**, which would deny a consumer any chance to degrade.

This also keeps the change non-breaking: a consumer on Node 22 who works today still works, and now
knows why if something later breaks.

Two details follow the codebase rather than inventing anything:

- **`resetNodeVersionWarning` is exported**, like `resetTemperatureWarning` and
  `resetProviderDetectionWarning`. Every warn-once path here exposes a reset seam so tests are not
  order-dependent.
- **An unreadable version is not treated as an old one.** Same rule as an unknown model price:
  never guess.

`warnIfUnsupportedNode(version = process.versions.node)` takes the version as a parameter so it is
testable in-process, with no second Node install and no subprocess.

## Consequences

- **`MINIMUM_NODE_MAJOR` is pinned against `package.json` by a test**, so the constant and
  `engines.node` cannot drift apart. That test is the reason this does not become its own stale
  fact.
- **Both messages are now gated.** `scripts/check-error-coverage.mjs` requires the new CLI error on
  the error reference, and `check-docs-exports.mjs` requires the new export on a Reference page. The
  CLI message is additionally provoked for real by `examples/diagnose-errors.mjs` and asserted by
  Doc Detective, so a reword breaks the build in three places.
- **The docs claimed there was no runtime check.** `get-started/index.mdx` said so accurately when
  it was written; it now describes the warning, and still explains `EBADENGINE`, which remains true.
  `reference/warnings.mdx` went from four warnings to five.
- **One throw site still cannot be checked.** `openai-compat.ts:141` re-throws the provider's own
  message (`throw new Error(\`${message}\`)`) and has no literal text to fingerprint. The coverage
  gate reports it explicitly rather than counting it as passing — 21 of 22 documented.
- The warning fires on a hot-ish path (`completeValidatedJSON`), guarded by a module-level boolean.
  Negligible, and the alternative — checking only at construction — misses direct provider users.

## Process note

Both fixes were implemented by subagents working in isolated git worktrees, then integrated here.
Isolation mattered: `tsup` builds with `clean: true`, so two agents building concurrently in one
checkout would have raced on `dist/`, and both changes touch
`docs/src/content/docs/troubleshooting/index.mdx`.

One correction on integration. The CLI agent skipped adding a Doc Detective assertion for its new
message, reasoning that `stdio` is regex-matched and `(is it logged in?)` contains metacharacters.
That is wrong: `stdio` is a substring match unless the value is wrapped in `/…/`. The assertion was
added and passes.
