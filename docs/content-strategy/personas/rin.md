---
id: persona-rin
type: persona
name: Rin
audience: aud-evaluating-adopters
lead: false
role: Maintainer of an existing Node tool, evaluating whether to take this dependency
proficiency:
  - Node and npm, general TypeScript
  - Reading a README critically and deciding fast
  - Has used a vendor LLM SDK directly at least once
prerequisites:
  - Has a concrete feature in mind that needs a model
  - Can install a package and run a script
  - Knows what JSON Schema is
goals:
  - Decide in minutes whether this package fits, including deciding it does not
  - Run something real without creating an API account
  - See the actual shape of the contract before committing
  - Understand what adopting costs — dependencies, Node version, module system
pains:
  - Nothing runnable without a key, so evaluation stalls at the first step
  - Provider choice looks like a commitment it is not
  - The two-layer structure is not obvious, so an extraction need looks like an eval framework
  - The API section is 43 bare names with no signatures — the contract is invisible
content_types:
  - A landing page that routes rather than explains
  - One short quickstart that runs on a bare machine
  - Comparison and decision tables
  - Explicit non-goals stated early
journeys:
  - cuj-first-validated-call
  - cuj-choose-a-provider
  - cuj-test-without-network
---

Rin maintains a Node tool and has a feature in mind that needs a model. No integration exists yet.
The docs are the entire basis for the adoption decision, and the decision is measured in minutes.

Rin is the only persona defined by a **missing prerequisite**: the library's vocabulary. Every other
persona can be addressed in the package's own terms. Rin cannot, and that single constraint governs
both pages in the Get started track.

## The decision, honestly

Rin is not deciding "is this library good." Rin is deciding **"is a deliberately narrow contract
worth a dependency, when the vendor SDK is right there?"**

The docs' job is to make that trade legible in both directions:

- **Given up:** streaming, multi-turn, tool loops. The provider contract is
  `(system, user, schema, temperature) -> JSON` and will not grow — widening it requires an ADR.
- **Gained:** one call shape across four providers, schema validation with a retry, a
  content-addressed cache, cost accounting that never guesses a price, and a mock seam that makes
  the whole integration testable without a network.

**A reader who needs streaming should be able to rule this out within thirty seconds.** That is a
success, not a lost conversion — and it is why the non-goals belong on the first screen rather than
in a FAQ.

## The evaluation blocker

Rin's first pain is the one that decides everything: if the first runnable thing requires an API
key, evaluation stops. Two paths remove that blocker and neither is currently discoverable from the
top of the README — `MockProvider`, which is exported for exactly this and needs no network at all,
and the local `llama-cpp` provider, which needs no account.

The on-ramp must lead with something that runs on a bare machine. Everything else is negotiable.

## How Rin reads

Skim first, in a hurry, deciding whether to keep reading. Headings and tables carry more weight than
prose. Any paragraph that must be read in full to extract one fact will be skipped, and the fact
lost.

The second read is different: if the skim passes, Rin runs the quickstart verbatim and expects it
to work with zero edits. A sample that needs an undocumented environment variable or a key ends the
evaluation for good.

## Writing for Rin

- **One new term per section, defined on first use.** Not `ProviderSpec`, not `InferenceRun`, not
  zones, not consensus — not until earned. Link the rest into Reference.
- Put the hard filters above the fold: **Node 24+, ESM only.** A reader on CommonJS should learn
  that before writing code, not after.
- Say what the package does not do, early and without apology.
- The landing page routes; it does not teach. Its job is to get each reader into the right track.
- Every sample in this track must run on a machine with no API key and no network.
- Show one real signature. The current README's bare-name list is the specific failure this track
  exists to fix.
