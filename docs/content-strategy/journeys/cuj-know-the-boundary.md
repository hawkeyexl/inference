---
id: cuj-know-the-boundary
code: X3
type: cuj
title: Know what stays in your repo
personas:
  - persona-priya
  - persona-marco
  - persona-rin
  - persona-owen
cross_cutting: true
trigger: The author is about to write something and cannot tell whether it belongs here or upstream
entry_point: /keep-it-working/boundary/
success_criteria: >
  The author can decide, without asking, whether a given piece of code belongs in their repo or in
  the library — and knows that reimplementing a provider, an ensemble, a cache, or a price table is
  the specific mistake to avoid.
steps:
  - stage: Read the line
    doc: /keep-it-working/boundary/
    exists: true
    note: What the library owns - the provider call, validation and retry, consensus math, zone routing, the cache mechanism, the price table. What you own - prompts, verdict wording, cache-key composition, config mapping, orchestration.
  - stage: Learn the specific anti-pattern
    doc: /keep-it-working/boundary/
    exists: true
    note: Never reimplement a provider, ensemble, cache, or price table locally. Three copies of that code drifted apart once already and a fix belongs upstream. All three consumers wrote this rule into their own agent instructions; the library never said it.
  - stage: Own your prompts
    doc: /judge/caching/
    exists: true
    note: This library ships no domain prompt text and no PROMPT_VERSION. Composing the key, and deciding what invalidates it, is yours.
  - stage: Own the verdict wording
    doc: /judge/verdict-schema/
    exists: true
    note: Field descriptions are prompt surface. The structure is the library's; the wording is yours.
  - stage: Own the orchestration
    doc: /judge/at-scale/
    exists: true
    note: Concurrency, retry policy above the call, and per-subject status all live in your repo. The library deliberately runs one subject at a time.
  - stage: Map your config yourself
    doc: /get-started/choose-a-provider/
    exists: true
    note: ProviderSpec is library-owned and flat. Map your own config into it rather than passing your config object through.
  - stage: Know when to push a fix upstream
    doc: /keep-it-working/boundary/
    exists: true
    note: If the fix is in a provider, the ensemble, the cache, or the price table, it belongs in the library. A local patch becomes the fourth divergent copy.
---

The page that tells a reader which side of the line a piece of code belongs on.

Cross-cutting: every persona hits this decision, usually within the first week.

## Why the library has to say it

All three production consumers independently wrote a version of this rule into their own agent
instructions:

> Never reimplement a provider, ensemble, cache, or price table here; three copies of that code
> drifted apart once already, and a fix belongs upstream.

That sentence exists three times in three repositories **because the library never said it**. The
extraction that created this package happened precisely because the same code had been copied three
times and drifted — each copy holding a fix the others lacked. The boundary is the whole reason the
package exists, and it was documented nowhere in the package's own docs.

## The shape of the answer

The split is not arbitrary, and stating the principle is more useful than the list:

**The library owns what is identical across consumers.** Talking to a provider, validating a
response, counting votes, pricing tokens — these are the same everywhere, and a bug in them is a bug
everywhere.

**You own what is specific to your domain.** Prompts, verdict wording, what invalidates a cache
entry, how your config maps to a spec, how you orchestrate across subjects. A library-chosen answer
to any of these would be wrong for every consumer.

A reader who internalises that principle can classify a new case without consulting a table, which
is the point — the list will always be incomplete.

## Where this page pulls its weight

It is short, and it is linked from every track, because the failure it prevents is expensive and
silent. Nobody notices a fourth divergent copy of the provider layer until a fix lands in one of
them.
