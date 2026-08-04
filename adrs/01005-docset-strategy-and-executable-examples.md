---
status: "accepted"
date: 2026-08-03
decision-makers: [hawkeyexl]
---

# A CUJ-first documentation set, with samples that CI executes

## Context and Problem Statement

The package shipped with one 381-line README, four ADRs, and no documentation site. That was
adequate while it was an extraction in progress. It is not now: `docevals`, `dockg`, and
`agentevals` consume it from the registry, and `docmeta` is a declared future consumer.

The README is accurate and dense, but it is a narrative, and its `## API` section names all 52
value exports **without a single signature, parameter list, or return value**. Everything a
consumer needs to get right lives somewhere they will not look — an ADR, a `CLAUDE.md` invariant,
or a source comment. The three consumers' own ADRs record what that cost them:

- `agentevals` ships `pricingOverrideFor()` because "a model the library's built-in table does not
  know prices at 0, which silently disables every `maxCostUsd` budget."
- `dockg` recompiled Ajv once per document before discovering the validator cache is keyed on
  schema object *identity* — documented only in a comment in `src/complete.ts`.
- All three independently invented a schema-recheck-on-read cache wrapper, an
  identity-without-construction thunk, and an `InferenceError` translation boundary.
- `EnsembleOptions.schema`, the override both judge consumers depend on, appears in ADR 01001 and
  in the type, and nowhere in the README.

Three separate teams solving the same problem three times is a documentation defect, not a
coincidence. This ADR records the three decisions behind the fix that a future reader would
otherwise re-litigate.

## Decision Drivers

* Consumers persist this library's output to disk and gate spending on its numbers; a wrong
  signature is a bug in four repositories, not a typo.
* A documentation sample that drifts from the code is worse than no sample.
* Agents read these docs. Assertions must be verifiable, not prose.
* The library has no CLI, so the sibling repos' `runShell`-based doc-testing pattern does not port.

## Decision 1: CUJ-first information architecture, not Diátaxis

**Chosen: organize the site around what four evidence-derived personas must accomplish**, with one
nav track per persona plus a flat Reference shelf that journeys deep-link into. The strategy lives
in [`docs/content-strategy/`](../docs/content-strategy) — audiences, personas, fourteen CUJs, and
the IA — inside `docs/` but outside `docs/src/content/docs/**`, so it is versioned with the site
and never published.

Rejected: a Diátaxis tutorial / how-to / explanation / reference split. It would scatter the lead
persona's anchor journey across four sections, and force a reader who only needs single-shot
extraction through judge-layer material to reach completion answers. The two layers are meant to be
separable; the IA has to preserve that.

The personas are derived bottom-up from the three shipped integrations and their ADRs, not
invented. Since the evidence is public repositories rather than private conversations, nothing is
anonymized and sources are named.

### Consequence

Adding a page means naming the CUJ it serves and recording it in
`information_architecture/proposed-ia.md`. A page that cannot name its CUJ does not belong in the
nav. That is intended friction.

## Decision 2: samples live in `examples/` at the repo root

**Chosen: every runnable sample is a real `.mjs` file in `examples/`**, rendered onto its page with
a Starlight `<Code>` and a `?raw` import, so a page cannot show code that differs from the file CI
runs.

The samples import the package **by its published name**:

```js
import { MockProvider, completeValidatedJSON } from "@hawkeyexl/inference";
```

This resolves via Node's package self-reference — a package with a `name` and an `exports` map can
import itself from inside its own directory — so it resolves to `dist/index.js` after
`npm run build`. Nothing in a sample is a lie about what a consumer types.

Rejected: `docs/examples/`. `docs/` is its own private npm workspace with `"name":
"inference-docs"`, so self-reference from inside it would resolve to *that* package and the samples
would need a relative path into `src/` — visibly not what a consumer writes.

Also rejected: a `file:` or `link:` dependency from `docs/` back to the root. `CLAUDE.md` bans
those outright, and the ban should not acquire an exception for convenience.

### Consequence

`examples/` must stay out of the published tarball. `files: ["dist"]` already handles it, and
`ci.yml`'s package-contents gate now asserts it explicitly, alongside `docs/`.

## Decision 3: Doc Detective `runCode`, launching a repo file and asserting with `stdio`

**Chosen: inline Doc Detective tests using `runCode`**, where each step is a one-line CommonJS
launcher that runs an `examples/` file, and the step's own `stdio` field carries the assertion:

```jsonc
{
  "runCode": {
    "language": "javascript",
    "code": "process.stdout.write(require('node:child_process').execFileSync('node',['examples/first-call.mjs'],{encoding:'utf8',stdio:['ignore','pipe','inherit']}))",
    "stdio": "result: { summary: 'Covers authentication and token refresh.' }"
  }
}
```

One assertion per step, so a failure names exactly which claim broke.

### Why a launcher rather than an inlined snippet

`runCode` writes the snippet to `os.tmpdir()` and runs `node <tmpfile>`. **Module resolution
therefore happens from the temp directory, not from this repository**, so a bare specifier cannot
resolve by either mechanism. Measured against `doc-detective@4.37.1`:

| Inlined into a `runCode` step | Result |
|---|---|
| `import { makeProvider } from "@hawkeyexl/inference"` | `ERR_MODULE_NOT_FOUND` |
| `require("@hawkeyexl/inference")` | `MODULE_NOT_FOUND` |

A sample therefore cannot be inlined; it has to be launched from a file inside the package, where
self-reference resolves. That is the whole reason the launcher exists.

### A correction worth recording

An earlier revision of this ADR claimed `runCode` silently drops `stdio` and `workingDirectory`,
and built the harness around `node:assert` because of it. **That was wrong.** It was measured
against a stale vendored copy of `doc-detective@4.0.0-beta.0` found elsewhere on the machine, not
against the current release. The behavior was real in that beta and has since been fixed upstream —
`src/core/tests/runCode.ts` now forwards the options explicitly and documents the old drop as the
bug it was.

Re-measured against `4.37.1`:

| Behavior | Result |
|---|---|
| `stdio` assertion | **honored** — a mismatch fails the step |
| `exitCodes` | honored |
| `workingDirectory`, absolute | honored |
| `workingDirectory`, relative | fails on Windows with `ENOENT` (`-4058`) |

So `stdio` is the assertion mechanism, which is both idiomatic and self-documenting in the step
JSON. `workingDirectory` is left unset and Doc Detective is invoked from the repository root, so the
launchers' relative paths resolve without depending on the one form that is not portable. That
constraint is recorded in `.github/workflows/doc-detective.yml`.

The lesson generalizes past this ADR: **verify against the version actually in use.** A vendored
copy on disk is not evidence about the current release.

Rejected: `runShell` steps. They would work — the launcher is a shell invocation in all but name —
but `runCode` states the language explicitly and keeps the step readable.

Also rejected: a vitest suite that imports each example. It would be simpler, but it would not
verify the *page* — only the file. The `?raw` import plus an executed launcher is what closes the
loop between what a reader sees and what runs.

### Consequences

* Every tested sample uses `MockProvider` or an injected `LlamaRuntime`. No test needs a network, a
  credential, or GGUF weights — consistent with the repo's existing "no network in tests" invariant.
* Two paths are documented but **not** executed: a real hosted-provider call and a real local-model
  run. Both are flagged as unexecuted on their pages and in `ia-gap-analysis.md`.
* `doc-detective.yml` refuses fork pull requests, because these steps execute code from the diff.
* The `stdio` gap is an upstream bug. If it is fixed, the launchers keep working unchanged —
  they simply gain a redundant second assertion path.

## Known gaps

* **Export coverage is a presence check, not a correctness check.**
  `scripts/check-docs-exports.mjs` (run in `ci.yml`) parses the built barrel and fails when an
  exported symbol appears on no page under `docs/src/content/docs/reference/`. It cannot tell
  whether the signature documented there is *right* — only that the symbol was not forgotten. A
  stronger check would have to compare declared signatures against the `.d.ts`, which is a larger
  piece of work and is not done.
* `scripts/check-docs-links.mjs` (run in `docs.yml`) gates dead internal links, since Starlight
  builds happily with one.
* `scripts/check-strategy-anchors.mjs` (run in `docs.yml`) gates the three invariants in
  `docs/content-strategy/README.md`: no dangling `aud-*`/`persona-*`/`cuj-*` references, no persona
  without a CUJ or CUJ without a persona, and every CUJ route resolving to a real page. That last
  one is the check nothing else could do — journey routes are never links in built HTML, so the link
  checker cannot see them, and renaming a page would otherwise silently orphan every journey routing
  through it.
* **Eight Phase 2 pages ship as stubs**, each carrying its CUJ and accurate-but-brief content, so no
  journey step points at a 404. Five CUJs are not yet walkable end to end; their journey files mark
  the affected steps `exists: partial`, and the anchor check enforces the converse — a step claiming
  `exists: true` may not point at a page still badged "Planned".
