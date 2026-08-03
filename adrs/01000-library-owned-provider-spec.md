---
status: "accepted"
date: 2026-08-03
decision-makers: [hawkeyexl]
---

# A library-owned `ProviderSpec`, not consumer config objects

## Context and Problem Statement

In the three projects this library was extracted from, the provider factory took the consuming
tool's entire config object: docevals' `makeProvider(config: DocevalsConfig, options)` reached into
`config.provider.anthropic.model`, and dockg's `makeProvider(config: DockgConfig, options)` reached
into `config.fill.provider`. The two config shapes are unrelated, so the two factories could never
be the same function.

That coupling produced a concrete deformity. agentevals wanted docevals' providers, so its
`makeJudgeProvider` serialized its own provider config to YAML text and fed it back through
docevals' `parseConfig` just to obtain a `DocevalsConfig` that `makeProvider` would accept — and
took a `"docevals": "file:../docevals"` dependency to do it. A `file:` spec publishes verbatim to
npm and is banned by the sibling repos' own contribution rules.

How should a shared factory learn which provider to build, without knowing any consumer's config
schema?

## Decision Drivers

- Four consumers with four unrelated config schemas, one of which (docmeta) does not exist yet.
- Adding a provider must not require editing four config schemas.
- No consumer should have to model its config on another's, or depend on another, to reuse this.
- Cache keys and pricing need the provider *identity* even on a fully-cached run that must not
  require an API key.

## Considered Options

- A library-owned flat `ProviderSpec`, with each consumer mapping its config into it
- A generic config interface the consumers' config types structurally satisfy
- Keep taking consumer config objects, made generic over a type parameter
- A registry where consumers register provider factories at startup

## Decision Outcome

Chosen option: **a library-owned flat `ProviderSpec`**, because it inverts the dependency. The
library declares the small set of facts it needs (`provider`, `model`, `apiKeyEnv`, `baseUrl`,
`command`, plus provider-specific option bags), and each consumer writes one small mapping function
from its own config. No consumer's schema appears in this package, and no consumer needs another
consumer's package.

`resolveProviderIdentity(spec)` is kept as a separate export (ported from dockg) so identity is
available without construction.

### Consequences

- Good, because agentevals can drop its `file:../docevals` dependency and its YAML
  round-trip entirely — it maps its config to a `ProviderSpec` directly.
- Good, because docmeta can adopt this library later without inheriting anyone's config shape.
- Good, because adding a provider touches one file here plus whatever each consumer chooses to
  expose, rather than four config schemas up front.
- Bad, because each consumer now carries a small mapping function that must be kept in sync when
  `ProviderSpec` grows. This is a few lines per repo, and a compile error when a required field is
  added.
- Neutral, because `pricing` rides along on the spec despite not being used to construct anything —
  it lets a consumer pass one object to both `makeProvider` and `pricingFor`.

### Confirmation

`test/unit/providers.test.ts` constructs every provider from a bare `ProviderSpec` with no config
object in sight, and asserts `resolveProviderIdentity` resolves an Anthropic model with
`ANTHROPIC_API_KEY` deleted from the environment. A future change that reintroduced a config
dependency would not compile against those tests.

## Pros and Cons of the Options

### A library-owned flat `ProviderSpec`

- Good, because the dependency points from consumers to the library and never back.
- Good, because the shape is small enough to read in one screen and document in the README.
- Bad, because it is a fourth shape in a world that already has three config schemas.

### A generic config interface consumers structurally satisfy

- Good, because consumers would need no mapping function.
- Bad, because it forces every consumer to nest its provider settings at the same path, which is a
  library dictating a config schema — the same coupling, only implicit.
- Bad, because dockg's settings live under `fill.*` and docevals' under `provider.*`; neither would
  move without a breaking config change.

### Generic over the consumer config type

- Bad, because a type parameter does not remove the need for accessor logic; it just makes the
  accessors someone else's problem while keeping the awkward call shape.

### A provider registry

- Good, because consumers could add private providers.
- Bad, because it is startup-order-sensitive global state to solve a problem no consumer has: all
  four want the same four providers.
