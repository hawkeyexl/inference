---
id: cuj-cache-repeat-runs
code: P2
type: cuj
title: Make repeat runs free and deterministic
personas:
  - persona-priya
  - persona-marco
trigger: A second run over unchanged subjects costs the same as the first
entry_point: /judge/caching/
success_criteria: >
  Repeat runs over unchanged input hit the cache, replayed runs are flagged cached and charged
  nothing, the author knows exactly which facts compose their key, and a stale entry cannot become
  data.
steps:
  - stage: Understand the ownership split
    doc: /judge/caching/
    exists: true
    note: The library hashes what you name; it does not decide what invalidates an entry. No PROMPT_VERSION ships here.
  - stage: Compose a key
    doc: /judge/caching/
    exists: true
    note: buildCacheKey over provider, model, prompt version, ensemble size, and a sha256 of long content. Length-prefixing is why two different part lists cannot collide.
  - stage: Wire the cache into an ensemble
    doc: /judge/caching/
    exists: true
    note: JsonCache plus cacheKey on EnsembleOptions. Sample is examples/cache-replay.mjs, which runs twice and prints cached false then true.
  - stage: Confirm a replay costs nothing
    doc: /judge/caching/
    exists: true
    note: Replayed runs are re-flagged cached true, and costOfRuns skips them. The sample prints both costs.
  - stage: Reject a stale entry
    doc: /judge/caching/
    exists: true
    note: The library treats a corrupt or wrong-shaped entry as a miss, but cannot know your value shape. The recheck-on-read wrapper pattern, which three consumers each invented separately.
  - stage: Know what a write failure does
    doc: /judge/caching/
    exists: true
    note: Warns once per instance and continues. The cache is an optimization, never a dependency — a read-only workspace must not abort work already paid for.
  - stage: Look up the signatures and the file format
    doc: /reference/cache/
    exists: true
    note: JsonCache constructor arity, buildCacheKey, sha256, and the on-disk format.
---

Turning a re-run over unchanged input into a free, deterministic replay — and making sure a stale
entry can never become data.

Scoped to caching. Cost accounting is [`cuj-budget-judge-spend`](cuj-budget-judge-spend.md); what
invalidates an entry across an upgrade is [`cuj-upgrade-safely`](cuj-upgrade-safely.md).

## The ownership split is the whole lesson

This library ships **no domain prompt text and no `PROMPT_VERSION`**. `buildCacheKey` hashes the
parts the caller names; it does not decide what should invalidate an entry. That is deliberate —
each consumer has a different notion of what changed (a page body, a prompt revision, an ensemble
size, a requested field set) and a library-chosen answer would be wrong for all of them.

A reader who does not grasp this writes a key that is too narrow and serves stale verdicts, or too
wide and never hits. Everything else on the page follows from it.

## Two properties worth stating explicitly

- **Length-prefixing.** `buildCacheKey` prefixes each part with its length before joining, so
  `["a|b", "c"]` and `["a", "b|c"]` cannot collide. Readers composing keys from user-controlled
  strings should know the collision is handled rather than hoping.
- **Pre-hash long parts.** All three existing consumers independently wrote the same comment about
  keeping key parts short and `sha256`-ing large bodies first. Show it in the sample.

## The pattern three teams each invented

`JsonCache` deliberately does not know what shape any consumer stores. A corrupt or unparseable
entry is a miss, and `runEnsemble` treats a non-array cache hit as a miss rather than crashing — but
an entry that is *well-formed and obsolete*, written by an older version of the consumer's own
schema, will be replayed happily.

docevals, dockg, and agentevals each solved this the same way: wrap the cache and re-validate on
read. Three independent inventions of one pattern is a documentation gap. Naming it here is how a
fourth team avoids the discovery.

## The guarantee about failure

A cache write failure warns **once per instance** and the run continues. This is the "cache is an
optimization, never a dependency" invariant, and it is the reason a read-only workspace or a full
disk cannot abort a run whose inference already succeeded and was already paid for.

Marco reads this page too — his need is identical, minus the ensemble. Keep the mechanics separable
from the judge-layer framing.
