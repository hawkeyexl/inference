---
id: cuj-upgrade-safely
code: U1
type: cuj
title: Upgrade without invalidating my caches
personas:
  - persona-priya
  - persona-marco
  - persona-owen
trigger: A new version is available, and the consumer has a populated on-disk cache to protect
entry_point: /keep-it-working/upgrading/
success_criteria: >
  The consumer upgrades knowing whether their cached entries survive, which changes would invalidate
  them, and how release channels map to what they are installing.
steps:
  - stage: Know what is a file format
    doc: /keep-it-working/upgrading/
    exists: true
    note: JudgeRun is persisted to consumers' on-disk caches. Renaming or removing a field invalidates every cached ensemble in every consuming repo. It is treated as a file format, and such changes carry a BREAKING CHANGE footer.
  - stage: Know what invalidates a key
    doc: /keep-it-working/upgrading/
    exists: true
    note: The consumer composes the key, so the library cannot invalidate it. But provider id, model name, and the consumer's own prompt version are usually in it — and a resolved local selector changes the model name.
  - stage: Read the release channels
    doc: /keep-it-working/upgrading/
    exists: true
    note: semantic-release with conventional commits. main, next as a prerelease channel, and feat/** branches each getting their own npm dist-tag.
  - stage: Check the cache file format
    doc: /reference/cache/
    exists: true
    note: One JSON file per key, human-inspectable. A corrupt or wrong-shaped entry is a miss rather than a crash.
  - stage: Re-validate on read
    doc: /judge/caching/
    exists: true
    note: The recheck-on-read wrapper is what makes an upgrade safe when the consumer's own value shape changed. Cross-links to P2.
  - stage: Watch the local model pin
    doc: /local/choosing-a-model/
    exists: true
    note: Catalog entries pin an exact blob path so a model cannot silently re-point underneath a key that already names it. Relevant to anyone caching local results across an upgrade.
---

Upgrading a caret range without silently discarding a populated cache — or worse, replaying entries
that no longer mean what they meant.

Scoped to upgrade risk for consumers. Composing a key in the first place is
[`cuj-cache-repeat-runs`](cuj-cache-repeat-runs.md).

## The fact that makes this a journey

`JudgeRun` is persisted to consumers' on-disk caches. Its shape is therefore **a file format**, not
an internal type, and renaming or removing one of its fields invalidates every cached ensemble in
every consuming repository at once.

Three repos hold such caches today. That is stated as an invariant in the library's own `CLAUDE.md`
and is enforced by requiring a `BREAKING CHANGE:` footer so semantic-release majors correctly. What
does not exist is a page telling the *consumers* about it — the people whose caches would evaporate.

## What the library can and cannot invalidate

An honest split, and the reason this page can be short:

- **The library cannot invalidate a consumer's cache.** The consumer composes the key; the library
  only hashes the parts it is handed. There is no `PROMPT_VERSION` here and no library-owned
  invalidation signal, by design.
- **The library can change what a key *means*.** If `JudgeRun` gains or loses a field, an entry
  written before the upgrade deserializes into something different afterward.

So the consumer's protection is entirely their own: put a version marker in the key, and
re-validate on read. Both are covered in P2; this page's job is to explain *when* to bump the marker.

## Channels, briefly

semantic-release with conventional commits. `main` is the stable channel, `next` is a prerelease
channel, and `feat/**` branches each publish under their own npm dist-tag. A consumer on a caret
range gets `main` only — worth stating, because the dist-tag scheme otherwise looks like it might
reach them by accident.

## One local-model wrinkle

A resolved selector changes the model name that lands in the cache key. An operator who cached
results under `auto` on one machine and runs on another with more memory gets a different key, not a
stale hit — which is the outcome the async factory exists to guarantee. Worth one sentence, because
it looks like a cache miss bug and is not.
