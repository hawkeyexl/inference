# Claude Code Configuration

Repo-wide guidance for AI agents working on `@hawkeyexl/inference`. Conventions here are ported
from the sibling repos (docevals, dockg, agentevals, docmeta), which in turn follow
[doc-detective](https://github.com/doc-detective/doc-detective)'s repo guidance.

## Environment setup (required)

**Rebase onto `main` before doing anything else.** In a fresh worktree or stale checkout:

```bash
git fetch origin
git rebase origin/main
```

**Install dependencies.** This package has no sibling-checkout step and no `file:` dependencies:

```bash
npm install
```

CI mirrors this exactly. Use `npm install` rather than `npm ci`: the committed lock is generated on
Windows and omits the Linux-side optional dependencies of `@napi-rs/wasm-runtime` (rolldown's wasm
binding), so a strict lock check cannot pass on both platforms.

**Never introduce a `file:` or `link:` dependency spec.** npm publishes them verbatim, and this
package is consumed from the registry by four other repos. The whole point of this library is to
end the `"docevals": "file:../docevals"` arrangement that agentevals was stuck with.

Don't reach for `--no-verify` when a husky hook fails — fix the message instead.

## Persistent knowledge: repo instructions, not Claude memory (required)

Do **not** use Claude Code's auto-memory for knowledge about this repo. When you learn something
durable — a gotcha, a decision, a convention — record it **in the repo, in the same change**:

| Kind of knowledge | Home |
|---|---|
| Behavior decisions, contracts, trade-offs | [adrs/](adrs) (MADR) |
| Repo-wide agent workflow rules | This file |
| User-facing API, providers, options | [README.md](README.md) |
| Ephemeral working notes | `.tmp/` (gitignored) — never committed |

## Invariants of this codebase (required reading)

- **This is a library, not a tool.** No CLI, no `bin`, no commands, no config file loading, no
  file discovery. If a change needs to know about markdown pages, frontmatter, agent traces, or
  eval definitions, it belongs in a consumer, not here.
- **The provider contract is deliberately narrow:** `(system, user, schema, temperature) -> JSON`.
  No streaming, no multi-turn, no tool loops. Widening it needs an ADR — every consumer pays for
  surface area added here.
- **An errored run is recorded, never dropped and never coerced.** `completeValidatedJSON` returns
  a run with `error` set rather than throwing or inventing a result. Downstream, an errored run
  counts against consensus: it can push a result toward human review, but it can never produce a
  silent pass. This is the safety property the consuming eval tools are built on — do not
  "improve" it into a retry-until-success loop.
- **Unknown model price is `undefined`, and unknown cost is `0`.** Never guess a price. Budget
  gates depend on this.
- **The cache is an optimization, never a dependency.** A write failure warns once and the run
  continues. A corrupt entry is a miss. Neither ever aborts work already paid for.
- **The claude-cli prompt goes over stdin, never argv.** Windows caps the command line at ~32K
  characters and user content routinely exceeds it. `test/unit/claude-cli.test.ts` pins this.
- **No network in tests.** Every code path is exercised through `MockProvider` or an injected
  `ExecFn`. The only live test is `test/integration/live.test.ts`, gated on `ANTHROPIC_API_KEY`
  and skipped by default.
- **Consumers own their prompts and their cache keys.** This library ships no domain prompt text
  and no `PROMPT_VERSION`. `buildCacheKey` hashes the parts the caller names; it does not decide
  what invalidates an entry.

## Consumers (why compatibility matters)

`docevals`, `dockg`, and `agentevals` depend on this package from the npm registry; `docmeta` will
when it grows an inference path. A breaking change to the provider contract, `JudgeRun`'s shape, or
the cache file format is a breaking change for all of them — note it as `BREAKING CHANGE:` in the
commit footer so semantic-release majors correctly.

`JudgeRun` is persisted to consumers' on-disk caches. Renaming or removing one of its fields
invalidates every cached ensemble in every consuming repo. Treat its shape as a file format.

## Branches and pull requests (required)

Changes land on `main` via a branch and a pull request, not direct pushes. Branch names follow the
release channels (`feat/**` gets its own npm dist-tag; `fix/**`, `docs/**`, etc. for the rest). The
PR body carries the docs-impact statement and links any ADRs. CI must be green before merge.

## Development workflow (required)

Always **red → green** TDD: write the failing test first, run it to confirm it fails for the right
reason, then implement. Before opening a PR:

```bash
npm run typecheck
npm run build
npm test
```

## Architecture Decision Records

Behavior decisions ship with an ADR in [MADR 4.0.0](https://adr.github.io/madr/) format under
[adrs/](adrs). Filename: `NNNNN-kebab-case-title.md`, 5-digit zero-padded, numbering from `01000`.
Write one when a change alters the public contract, the safety properties above, or a trade-off a
future reader would otherwise re-litigate.

## Releases

semantic-release, conventional commits, `.releaserc.json` channels matching dockg's. The release
workflow is `workflow_dispatch`-only until the release GitHub App secrets and npm trusted
publishing are configured — see the header comment in
[.github/workflows/release.yml](.github/workflows/release.yml).
