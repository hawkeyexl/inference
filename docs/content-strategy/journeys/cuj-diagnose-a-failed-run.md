---
id: cuj-diagnose-a-failed-run
code: X2
type: cuj
title: Diagnose a failed run
personas:
  - persona-priya
  - persona-marco
  - persona-rin
  - persona-owen
cross_cutting: true
trigger: A run threw, or came back with error set, and the reader does not know which or why
entry_point: /troubleshooting/
success_criteria: >
  The reader identifies which of the two failure classes they are in, finds the exact message they
  saw, and knows the specific fix — without reading any page about how the library is designed.
steps:
  - stage: Split by symptom
    doc: /troubleshooting/
    exists: true
    note: Did it throw, or did it arrive on run.error? That one question routes everything else, and it is the taxonomy the docset already teaches on five pages without ever giving it a page to live on.
  - stage: Find the message
    doc: /reference/errors/
    exists: true
    note: All 21 throw sites, verbatim, each with its trigger and fix. Grouped by thrown InferenceError versus recorded on run.error. This is what makes a pasted error string findable in search.
  - stage: Read the common failures in prose
    doc: /troubleshooting/common-failures/
    exists: true
    note: The failures that need more than a table row - no provider available, a missing key, a selector in a sync factory, node-llama-cpp absent, a Claude CLI not on PATH, a 429, and a schema the model cannot satisfy.
  - stage: Understand a warning
    doc: /reference/warnings/
    exists: true
    note: The four console.warn paths, their once-per scope, and the two reset seams. Nothing else in the docset says the library writes to console.warn at all.
  - stage: Recognise a rate limit for what it becomes
    doc: /judge/at-scale/
    exists: true
    note: A 429 arrives as an errored run, and an errored run forces human-review. A rate limit silently becomes a review queue rather than a visible failure.
  - stage: Handle it in code
    doc: /extract/budgets-and-errors/
    exists: true
    note: Once the reader knows which class they are in, this is where the handling boundary lives - translate operational failures, record model failures, degrade rather than fail.
  - stage: Land here from a bad URL
    doc: /404/
    exists: true
    note: The 404 routes to this track. A reader who guessed /errors/ or /troubleshooting/ should not hit a dead end.
---

The journey the docset did not have. A reader whose run just failed, starting from the symptom
rather than from the architecture.

Cross-cutting: all four personas complete it, from four different tracks. Like
[`cuj-test-without-network`](cuj-test-without-network.md) it has no primary owner, because the
answer does not depend on which track you came from.

## Why it was missing

The docset reasons about failure at the level of **policy** — operational versus model, thrown
versus recorded, translate at the boundary — and repeats that policy across five pages. It
documented almost no **instances**. Of 21 throw sites, two messages appeared verbatim anywhere, and
fifteen had no coverage at all.

The gap was structural rather than accidental: **no CUJ covered a failed run**, so no page was ever
chartered for one. A sibling project identified "fix a failing check" as its highest-traffic
audience; this set had no equivalent journey.

The sharpest consequence: the zero-config path the docs actively promote fails with
`No inference provider is available. Tried:` — and that string appeared nowhere in the built site,
so pasting it into search returned nothing.

## The organising question

Every other page in this set is organised by what the reader is *building*. This one is organised
by what they are *seeing*, because a stuck reader does not know which layer they are in:

> **Did it throw, or did it come back on `run.error`?**

That question separates operational failures (a missing key, an unknown provider, a selector in a
sync factory — all `InferenceError`, all thrown at construction) from model failures (validation
exhausted, a provider error, a timeout — all recorded, never thrown). Two classes, two fixes, and a
reader who knows which one they are in has already done most of the diagnosis.

## What makes this journey verifiable

`examples/diagnose-errors.mjs` provokes the documented errors for real and prints them. The strings
on the reference page are therefore CI-checked by `stdio` assertions, and
`scripts/check-error-coverage.mjs` fails the build when a `throw` in `src/` has no entry.

A reworded error message breaks the build rather than silently drifting away from the page that
documents it. That matters more here than anywhere else in the set: an error reference that has
rotted is worse than none, because it sends readers looking for a string that no longer exists.
