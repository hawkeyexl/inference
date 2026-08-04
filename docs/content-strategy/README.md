# Content strategy

This directory holds the durable content strategy for the `@hawkeyexl/inference` documentation
site: who the docs are for, what those readers must accomplish, and which page carries each
outcome. It is the reference every writing task consults before drafting.

These files live inside `docs/` but outside `docs/src/content/docs/**`, so Starlight never builds
them into the published site. They are internal working documents for agents and contributors.

## Files

| Path | Contents |
|---|---|
| `audiences/` | Four target segments on the ownership × integration-depth axis, plus `_overview.md`. |
| `personas/` | One minimal persona per audience — Priya, Marco, Rin, Owen — plus `_overview.md`. |
| `journeys/` | Fourteen CUJs, one file each, plus `_overview.md` carrying the persona → CUJ coverage matrix. |
| `information_architecture/proposed-ia.md` | The CUJ-first nav tree, the full content set, the source-of-truth map, and the phased rollout. |
| `information_architecture/ia-gap-analysis.md` | What exists today, where it maps, and every gap the CUJs require. |

## The ID model

Every artifact declares a stable `id:` and references others by ID. Nothing is referenced by title.

| Artifact | ID prefix | References |
|---|---|---|
| Audience | `aud-*` | — |
| Persona | `persona-*` | `audience:` → exactly one `aud-*` |
| CUJ | `cuj-*` | `personas:` → one or more `persona-*`; `steps[].doc` → a real site route |
| IA | (none) | derives from `cuj-*` |

Two invariants hold at all times, and are checked before any docs PR merges:

- **No danglers.** Every `aud-*`, `persona-*`, and `cuj-*` reference resolves to a defined `id:`.
- **No orphans.** Every persona has at least one CUJ; every CUJ names at least one persona.

IDs are stable once published — they are referenced across these files and from `CLAUDE.md`.

CUJs also carry a short `code:` (`R1`, `P2`, `M3`, `O1`, `X1`, `U1`). The code is the vocabulary
used in prose, in the IA tables, and in `CLAUDE.md`; the `id:` is the machine-checkable anchor.
The letter is the persona's initial — R(in), P(riya), M(arco), O(wen) — except `X` (cross-cutting)
and `U` (upgrade), which belong to no single persona.

## Route notation

`steps[].doc` uses the **content-relative route**, not the deployed URL. `/judge/caching/` means
`docs/src/content/docs/judge/caching.mdx`. The deployed URL adds the `base` from
`docs/astro.config.mjs`. Writing routes this way keeps them checkable against the file tree
regardless of where the site is hosted.

Each step also carries `exists:`:

- `true` — the route resolves to a real file today.
- `partial` — a file exists but does not yet cover this step's outcome.
- `false` — required content that does not exist. Paired with a `[GAP]` note. **These are signal
  for the gap analysis, not errors.**

## How to use this during writing tasks

Before drafting or editing any page under `docs/src/content/docs/**`:

1. **Identify the persona.** Priya (eval-tool author, lead), Marco (CLI feature integrator),
   Rin (adopting maintainer), or Owen (offline/cost-zero operator). A page may serve more than
   one, but there is always a primary. See `personas/_overview.md`.

2. **Find the CUJ.** Every page is justified by at least one. Read the CUJ file and understand the
   end-to-end outcome before writing a word of the page.

3. **Structure around the journey, not the document type.** Do not impose a Diátaxis
   tutorial/how-to/explanation/reference split as the organizing principle. Ask what the persona
   needs to know, and in what order, to reach the outcome. Let the journey sequence the content.

4. **Link into the Reference shelf for lookups.** Signatures, full option tables, and the price
   table belong in `reference/`. Journey pages explain the path and link into reference for
   exhaustive detail — they do not duplicate it.

5. **Check `proposed-ia.md`.** It lists every planned page, the CUJ it serves, and its ★ launch
   status. Adding a page means recording it there in the same change.

6. **Frontmatter.** Every page in `docs/src/content/docs/**` needs `title` and `description`.
   No exceptions.

## Verifying technical claims

These docs describe a library whose consumers persist its output to disk and gate spending on its
numbers. A wrong signature is not a typo — it is a bug in four repos.

- **Source is the contract for behavior.** `information_architecture/proposed-ia.md` carries a
  source-of-truth map pairing each Reference page with the files it must not contradict. Cross-read
  those before writing.
- **The test suite is the contract for exact strings and edge cases.** `test/unit/*.test.ts` pins
  behavior the types do not express — that a corrupt cache entry is a miss, that a tie is not a
  pass, that an errored run forces `human-review`. Verify against assertions, not assumptions.
- **Every runnable sample is a real file.** Samples live in `examples/*.mjs` at the repo root, are
  rendered into pages via a `?raw` import so the page cannot drift from the file, and are executed
  in CI by Doc Detective. Never hand-write a sample inline. See `keep-it-working/testing.mdx` and
  ADR [01005](../../adrs/01005-docset-strategy-and-executable-examples.md).
- **Samples use `MockProvider`.** No tested example requires an API key or a network. A sample that
  genuinely cannot run key-free is shown but not executed, and is flagged as such in the IA.

## Where this strategy came from

Not from interviews. From three production integrations and their written post-mortems:
[docevals](https://github.com/hawkeyexl/docevals), [dockg](https://github.com/hawkeyexl/dockg), and
[agentevals](https://github.com/hawkeyexl/agentevals) each consume this package from the registry,
and each recorded an ADR describing what the extraction cost them and where the library's docs left
them guessing. `ia-gap-analysis.md` cites those findings directly. A fourth repo,
[docmeta](https://github.com/hawkeyexl/docmeta), is a declared future consumer and stands in for the
not-yet-adopted reader.

Because the evidence is public repositories rather than private calls, there is no `_evidence/`
directory and nothing here is anonymized. Sources are named.
