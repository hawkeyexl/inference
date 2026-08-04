---
id: cuj-exec-seam
code: M3
type: cuj
title: Reuse the exec seam for non-LLM subprocesses
personas:
  - persona-marco
trigger: The host CLI needs to shell out cross-platform, and already depends on this package
entry_point: /extract/subprocess-seam/
success_criteria: >
  The author uses realExec for their own subprocesses, injects ExecFn to test without spawning, and
  knows the four behaviors that make it safe on Windows and with hostile children.
steps:
  - stage: Learn the seam is public
    doc: /extract/subprocess-seam/
    exists: true
    note: realExec, ExecFn, ExecOptions, and ExecResult are exported and usable on their own. dockg drives git log with them.
  - stage: Run a command
    doc: /extract/subprocess-seam/
    exists: true
    note: realExec takes an argv array — no shell, so no quoting hazards. Returns code, stdout, stderr, timedOut, and spawnError rather than throwing.
  - stage: Pass input over stdin
    doc: /extract/subprocess-seam/
    exists: true
    note: opts.input is piped and the stream closed. The claude-cli provider relies on this because user content routinely exceeds the ~32K Windows argv limit.
  - stage: Unset an inherited environment variable
    doc: /extract/subprocess-seam/
    exists: true
    note: An env value of undefined unsets rather than blanks. dockg needed this to clear GIT_* vars, since empty string is not the same as unset to git. The type fix that shipped in 0.1.0.
  - stage: Survive a hostile child
    doc: /extract/subprocess-seam/
    exists: true
    note: The timeout settles on the timer itself, not on close, so a SIGTERM-ignoring child cannot hang the caller. Multi-byte UTF-8 straddling chunk boundaries decodes correctly.
  - stage: Inject a fake for tests
    doc: /extract/subprocess-seam/
    exists: true
    note: ExecFn is the seam. Pass one through ProviderSpec.exec for claude-cli, or into your own code, and never spawn in a unit test.
  - stage: Look up the signatures
    doc: /reference/exec/
    exists: true
    note: ExecFn, ExecOptions, ExecResult, realExec, and the two distinct default timeouts.
---

Using the package's subprocess helper for the host CLI's own commands, and injecting a fake to keep
unit tests off the process table.

Scoped to the exec seam. It is the one journey in this set that involves no model at all.

## Why a subprocess helper is in an inference library

Because the `claude-cli` provider needs one, and the one it needs turned out to be non-trivial. Four
behaviors were each earned by a real failure, and together they make it worth exposing rather than
hiding:

- **stdin over argv.** User content routinely exceeds the ~32K Windows command-line limit, so the
  prompt is piped rather than passed as an argument. `test/unit/claude-cli.test.ts` pins this with a
  40,000-character prompt.
- **UTF-8 across chunk boundaries.** Both pipes get `setEncoding("utf8")`, so a multi-byte character
  split across two chunks decodes correctly instead of becoming replacement characters.
- **Timeout settles on the timer.** Not on `close`. A POSIX child that ignores SIGTERM cannot hang
  the caller.
- **`env` values accept `undefined` to unset.** Not blank — unset. Empty string and absent are
  different things to `git`, and this distinction is the one upstream type fix the extraction
  required.

## The evidence that it should be documented

dockg imports `realExec` and `ExecFn` in `src/core/git.ts` to drive `git log`. Nothing to do with
inference. It works, it is cross-platform, it is tested, and it is already a dependency.

Meanwhile the type fix that made `env` unsetting expressible came *from* that use — `realExec`
already supported it, and only the type was wrong. A capability discovered by accident, fixed on
request, and never written down is precisely what this journey corrects.

## No shell, and why that is a feature

`realExec` takes an argv array and never sets `shell: true`. No quoting hazards, no injection
surface, and npm shims still resolve on Windows. Readers used to `exec("cmd string")` need this
stated, because the difference is the first thing they will trip on.

## The test story

`ExecFn` is the injection point. A unit test passes a fake and asserts on the argv and the piped
input without spawning anything — the same pattern the library uses on itself. Cross-links to
[`cuj-test-without-network`](cuj-test-without-network.md), which covers all three seams together.
