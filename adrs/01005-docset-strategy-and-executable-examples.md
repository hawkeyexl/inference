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

## Decision 3: Doc Detective `runCode`, with assertions on the exit code

**Chosen: inline Doc Detective tests using `runCode`**, where each step is a small CommonJS
launcher that runs an `examples/` file, captures its stdout, and asserts substrings:

```js
const { execFileSync } = require("node:child_process");
const assert = require("node:assert");
const out = execFileSync("node", ["examples/first-call.mjs"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
assert.ok(out.includes("Covers authentication and token refresh."), out);
```

The launcher shape is forced by two verified properties of `doc-detective-core`'s `runCode`
(measured against `doc-detective@4.0.0-beta.0`, not assumed):

1. **It writes the snippet to `os.tmpdir()` as a `.js` file and runs `node <tmpfile>`.** A bare
   specifier cannot resolve from there — probed directly, `ERR_MODULE_NOT_FOUND`. And with no
   `package.json` alongside it, a `.js` file is parsed as CommonJS, so an `import` statement cannot
   parse at all. This package is ESM-only. A sample therefore **cannot** be inlined into a
   `runCode` step; it has to be launched from a file in the repo.

2. **`runCode` rebuilds the step for `runShell` and forwards only `command` and `args`.** `stdio`,
   `workingDirectory`, `timeout`, and the rest are dropped. Verified empirically: a step asserting
   `stdio` against a string that is never printed **passes**. Exit codes survive, because
   `runShell` re-applies its own `[0]` default.

So `stdio` cannot be used as the assertion mechanism — it would silently never run — and
`workingDirectory` cannot be relied on. Assertions ride on the exit code via `node:assert`, and
Doc Detective must be invoked from the repository root so the launchers' relative paths resolve.
Both constraints are recorded in `.github/workflows/doc-detective.yml`.

Rejected: `runShell` steps. They work, but the samples are multi-line TypeScript-shaped ESM, and
the user asked for `runCode`; the launcher makes `runCode` work correctly.

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
