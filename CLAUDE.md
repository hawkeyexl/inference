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
| User-facing API, providers, options | [docs/](docs) — the site; [README.md](README.md) routes into it |
| Who the docs serve and why a page exists | [docs/content-strategy/](docs/content-strategy) |
| Ephemeral working notes | `.tmp/` (gitignored) — never committed |

## Documentation work (required before writing any user-facing page)

Docs live in [docs/](docs) as a private Astro/Starlight workspace. Read on demand — do not assume:

| Path | What it holds |
|---|---|
| [docs/content-strategy/](docs/content-strategy) | Audiences, personas, CUJs, and the IA. **Start here.** |
| `docs/content-strategy/journeys/` | 14 CUJs. Every page must name the one it serves. |
| `docs/content-strategy/information_architecture/` | The page-by-page content set and the source-of-truth map. |
| `docs/src/content/docs/**` | The published pages. |
| [examples/](examples) | Every runnable sample. Never inline one into a page. |

Four personas, referenced by first name throughout: **Priya** (eval-tool author, lead), **Marco**
(CLI feature integrator), **Rin** (adopting maintainer), **Owen** (offline/cost-zero operator).
CUJ codes are `R1`–`R2`, `P1`–`P4`, `M1`–`M3`, `O1`–`O3`, `X1`, `U1`; `P1` is the anchor.

1. Identify the persona, then the CUJ. A page that cannot name its CUJ does not belong in the nav.
2. Structure around the journey, **not** document type. This IA is deliberately not Diátaxis.
3. Put signatures and option tables in `reference/`; journey pages link into them.
4. Every page needs `title` and `description` frontmatter.
5. Every runnable sample is a file in `examples/`, rendered via a `?raw` import and executed in CI
   by Doc Detective. Adding one means adding a `runCode` step whose `code` launches the file and
   whose `stdio` carries one assertion — see
   [ADR 01005](adrs/01005-docset-strategy-and-executable-examples.md) for why a sample cannot be
   inlined into the step.
6. Adding a page means recording it in `information_architecture/proposed-ia.md` in the same change.

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
- **Verify against the real machine; fake only external services.** A test double is permitted
  *only* where the thing being stood in for is a network call to a third party: a remote LLM API
  (`MockProvider`), the Claude CLI's inference (`claude -p`, which calls Anthropic), or a Hugging
  Face model download. **Everything else must run for real** — spawn real processes, write real
  files in `mkdtempSync` directories, load the real `node-llama-cpp` binding, read the real
  environment. See "Real-machine verification" below for why.
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

When the change touches `docs/**` or `examples/**`, also:

```bash
cd docs && npm install && npm run build && cd .. && node scripts/check-docs-links.mjs && npx doc-detective
```

`npm run build` at the root must come first — `examples/*.mjs` import the package by its published
name via Node's package self-reference, which resolves to `dist/`. Run `doc-detective` from the
repository root: its `runCode` launchers use paths relative to the working directory, and
`workingDirectory` is deliberately left unset because a relative value fails on Windows.

**Use a current `doc-detective`.** `npx doc-detective` resolves the latest release; do not run a
vendored copy found elsewhere on the machine. An early `4.x` beta silently dropped `stdio` from
`runCode` steps, which makes every assertion here pass unconditionally — a false green that looks
exactly like a healthy run. ADR 01005 records the episode.

## Real-machine verification (required)

**Fake only what is a network call to a third party. Run everything else for real.**

Permitted doubles, and nothing else:

| Double | Stands in for | Why it stays |
|---|---|---|
| `MockProvider` | a remote LLM API | billed, rate-limited, non-deterministic |
| a fake `ExecFn` for `claude -p` | Claude CLI **inference** | it calls Anthropic |
| a fake `LlamaRuntime` for `prompt()` | inference over GGUF weights | needs a multi-GB Hugging Face download |

Everything else runs for real, and CI runs it: spawn actual processes (`process.execPath` with a
throwaway script proves argv, stdin, exit codes, timeouts and signal handling — see
`test/unit/exec.test.ts`), write actual files under `mkdtempSync`, load the actual `node-llama-cpp`
binding to probe availability, read the actual environment.

**Why this is a rule and not a preference.** Ten defects shipped past a green suite on the
local-models work, and the expensive ones were invisible *because* a fake made them free:

- `detectProvider` cost ~987 ms per construction and initialised the GPU for a provider it never
  used. Every test injected a `LlamaRuntime` whose probe returned instantly, so the cost did not
  exist in the suite.
- The Claude CLI probe memoised across different commands. Tests only ever passed one command.
- The download warning fired on the fully-cached path that downloads nothing. The test called
  identity resolution directly, so "what a real consumer does" was never exercised.

A fake encodes what you already believe. It cannot contradict you, so it cannot find these. Where
a real run is genuinely impossible in CI — it needs weights or a paid key — gate an integration
test on an environment variable (`INFERENCE_LIVE_LLAMA`, `ANTHROPIC_API_KEY`) and **run it by hand
before opening the PR**; a gated test still counts as verification, an un-run one does not.

Assert the *contract*, not the environment, in anything that touches optional native code: a probe
test should assert "returns a boolean and does not throw", so it stays honest on a machine where
the binding is absent.

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
