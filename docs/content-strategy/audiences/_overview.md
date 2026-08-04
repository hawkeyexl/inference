# Audiences — overview

This file names the segmentation axis and indexes the four audience files. It does not define the
segments themselves; each has its own file. For the people inside them, see
[`../personas/_overview.md`](../personas/_overview.md).

## Segmentation axis

**Who owns the inference call × how deep the integration goes.**

For a library, the equivalent of "who owns the docs × company maturity" is *who in the consuming
codebase owns the call into this package, and how much of the package's surface they touch*.
Everything else — which providers they configure, whether they need consensus math, whether cost
matters, how they test — falls out of that axis.

The segments were derived bottom-up from three shipped integrations, not assumed. Each is grounded
in code that exists.

| ID | Segment | Depth | Lead? | Grounded in |
|---|---|---|---|---|
| [`aud-ensemble-tool-builders`](ensemble-tool-builders.md) | Eval/judging tool authors | Both layers, nearly the whole surface | **Lead** | docevals, agentevals |
| [`aud-extraction-integrators`](extraction-integrators.md) | Structured-extraction integrators | Completion layer only | | dockg |
| [`aud-evaluating-adopters`](evaluating-adopters.md) | Maintainers deciding whether to adopt | None yet — that is the point | | docmeta (declared future consumer) |
| [`aud-local-model-operators`](local-model-operators.md) | Offline / cost-zero operators | The llama-cpp surface, cross-cutting | Cross-cutting lens | the local-model surface, `INFERENCE_LIVE_LLAMA` |

## Why ensemble tool builders lead

They touch every layer: provider construction, schema override, ensembles, consensus, zones,
caching, cost gating, and the mock seam. Anything written for them is read by the other segments
too. Both existing deep integrations sit here, and both independently invented the same three
workarounds — the clearest signal in the evidence that this segment is under-served.

## The cross-cutting lens

`aud-local-model-operators` is **not** a fourth parallel segment. It is a lens that cuts across the
other three: a tool builder running in CI without secrets, an extraction integrator on an air-gapped
network, and an adopter who wants to try the library without signing up for anything are all the
same reader wearing the same constraint.

It gets its own audience file and its own persona because the constraint changes the whole path —
an optional peer dependency to install, an async factory instead of a sync one, a multi-gigabyte
download to manage, and a different set of things that silently do not work (numeric bounds,
`required`, schema descriptions). That is a journey, not a footnote on someone else's page.

The overlap is real and deliberate: Owen's CUJs (`O1`–`O3`) are entered *from* the other tracks, and
`X1` (testing without a network) is shared by all four personas.

## What is not an audience here

- **Library maintainers.** Real readers, but served by `CLAUDE.md`, `adrs/`, and the repo's own
  conventions — not by the published site. Keeping them out is what keeps the IA CUJ-first.
- **End users of the consuming tools.** Someone running `docevals` never sees this package. Their
  docs are docevals' problem.
- **Prompt engineers.** This library ships no domain prompt text and no `PROMPT_VERSION`; consumers
  own their prompts. There is nothing here to serve them with.
