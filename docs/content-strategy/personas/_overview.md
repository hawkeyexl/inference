# Personas — overview

Four minimal personas, one per audience. This file is the index and the persona → audience map; the
profiles live in their own files. For the journeys each must complete, see
[`../journeys/_overview.md`](../journeys/_overview.md).

## The four

| Persona | Name and role | Home audience | CUJ letter |
|---|---|---|---|
| [`persona-priya`](priya.md) | **Priya** — eval-tool author (**lead**) | [`aud-ensemble-tool-builders`](../audiences/ensemble-tool-builders.md) | `P` |
| [`persona-marco`](marco.md) | **Marco** — CLI feature integrator | [`aud-extraction-integrators`](../audiences/extraction-integrators.md) | `M` |
| [`persona-rin`](rin.md) | **Rin** — adopting maintainer | [`aud-evaluating-adopters`](../audiences/evaluating-adopters.md) | `R` |
| [`persona-owen`](owen.md) | **Owen** — offline / cost-zero operator | [`aud-local-model-operators`](../audiences/local-model-operators.md) | `O` |

Priya is the lead persona: she touches every layer of the package, so her track gets the deepest
coverage and her journey `P1` is the anchor CUJ. Every persona has exactly one home audience.

## Minimal, and why

These are targeting instruments, not marketing personas. Each carries only what changes a writing
decision: what the reader already knows, what they are trying to do, what has actually gone wrong
for them, and which content types they will accept. No tenure, no team size, no tooling
preferences, no invented biography.

## The qualified-reader model

Personas here are defined by **what knowledge they bring and what subject dependencies they
have** — never by a beginner / intermediate / advanced label.

That distinction is load-bearing for a library like this one. Priya is expert at prompt design and
naive about provider API quirks. Owen is expert at CI and naive about GGUF. A single skill dial
cannot express either, and a page written to "intermediate" would over-explain JSON Schema to Priya
while leaving her guessing about `toStrictSchema`.

So each profile carries two lists that a writer can act on directly:

- **`prerequisites`** — assume it, do not explain it. Explaining it is condescension and noise.
- **What they do not bring** — explain it on first use, or link somewhere that does. Assuming it is
  the failure mode that produces a page nobody can follow.

When a page serves two personas, write for the one with the narrower `prerequisites` and link the
depth the other wants into Reference.

## Naming

First names are the shared vocabulary across this directory, the IA tables, and `CLAUDE.md`, so an
agent picks up the targeting without opening four files. Their initials are also the CUJ code
letters — `P1`, `M2`, `R1`, `O3`. Two codes belong to no persona: `X` (cross-cutting) and `U`
(upgrade).
