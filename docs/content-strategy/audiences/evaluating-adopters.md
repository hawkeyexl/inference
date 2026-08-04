---
id: aud-evaluating-adopters
type: audience
segment: Maintainers deciding whether and how to adopt
maturity: none yet — pre-integration
lead: false
docs_owner: A maintainer with an LLM-shaped feature in mind and no decision made
firmographics:
  - Has an existing Node/TypeScript tool and a feature that needs a model
  - Has not chosen a provider, and may not know the choice is separable from the call
  - Is weighing this package against calling a vendor SDK directly
  - May be evaluating on a machine with no API key at all
relationship_stages:
  - First contact — landing on the README or the site index
  - Evaluating — running something locally before committing
  - Committing — first real call in their own codebase
personas:
  - persona-rin
---

Maintainers who have a feature in mind and no integration yet. They are deciding whether this
package earns a dependency, and the docs are the entire basis for that decision. For the reader
inside it, see [`persona-rin`](../personas/rin.md).

This is the only audience defined by what it *lacks*: the vocabulary. Every other segment can be
addressed in the library's own terms. This one cannot, and that constraint governs the two pages
that serve it.

## The decision they are actually making

Not "is this library good." It is **"is a narrow contract worth a dependency, when the vendor SDK
is right there."** The honest answer is a trade, and the docs should make the trade legible rather
than sell:

- **What they give up:** streaming, multi-turn, tool loops. The provider contract is
  `(system, user, schema, temperature) -> JSON` and deliberately will not grow. If they need a
  conversation, this is the wrong package and should say so within the first screen.
- **What they get:** the same call across four providers, schema validation with a retry, a
  content-addressed cache, cost accounting that never guesses, and a mock seam that makes their
  tests network-free.

A reader who needs streaming should be able to rule the package out in thirty seconds. Failing
fast is a feature of this track, not a lost conversion.

## Defining pains

- **Nothing to try without a key.** Evaluation stalls if the first runnable thing requires signing
  up for an API account. `MockProvider` and the local llama-cpp provider both remove that blocker,
  and neither is discoverable from the top of the current README.
- **Provider choice looks like a commitment.** It is not — `makeProvider(spec)` takes a flat,
  library-owned shape, and swapping providers is a one-line change. A reader who does not know that
  will over-deliberate the first decision.
- **The two-layer structure is not obvious.** Completion and judge ship from one entry point. A
  reader who only needs extraction can easily conclude the package is an eval framework and leave.
- **No signatures anywhere.** The current README's API section is a list of 43 bare names. A reader
  evaluating the shape of the contract cannot see the contract.

## Buying constraints

Node 24+, ESM-only. Both are hard filters and belong above the fold, not in a footnote — a reader
on CommonJS or Node 20 should learn that before writing any code, not after.

Three runtime dependencies, one optional peer dependency. This is a small surface to take on, and
saying so is a legitimate part of the pitch.

## Qualified reader

They bring Node, npm, and general TypeScript. They bring a problem. They do **not** bring this
library's vocabulary — not `ProviderSpec`, not `InferenceRun`, not zones, not consensus. That is
the qualifying gap, and the on-ramp exists to close it.

Term discipline for the two pages that serve this audience: introduce at most one new term per
section, define it on first use, and link the rest into Reference rather than explaining inline.
