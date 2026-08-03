/**
 * Real spawned stand-ins for the `claude` executable.
 *
 * These are NOT test doubles for the CLI's inference — they are real Node
 * processes whose argv, stdin, exit code and timing exercise the same
 * `realExec` path production uses. Injecting a recorded `ExecFn` instead would
 * assert only that we call a function we wrote; it cannot catch a probe that
 * memoises across commands, an argv length limit, or a child that ignores
 * SIGTERM (see the real-machine verification rule in CLAUDE.md).
 *
 * The one thing still faked is what a real `claude -p` would *return*, because
 * that call reaches Anthropic.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCli {
  /** Spawnable path — hand this to `ProviderSpec.command`. */
  command: string;
  /** Where the script appends one JSON line per invocation. */
  recordPath: string;
  dir: string;
}

const isWindows = process.platform === "win32";

/**
 * Write a throwaway executable that records how it was invoked, then behaves as
 * `body` instructs. `body` may use `argv` (args after the script) and `stdin`.
 *
 * A `.mjs` file is not directly spawnable, so a tiny platform wrapper (`.cmd`
 * on Windows, `#!/bin/sh` elsewhere) is what actually gets executed — the same
 * shape as a real npm-installed CLI shim, which is precisely why `realExec`
 * uses cross-spawn.
 */
export function writeFakeCli(body: string): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "inference-cli-"));
  const script = join(dir, "cli.mjs");
  const recordPath = join(dir, "calls.jsonl");

  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch {}
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv, stdin }) + "\\n");
${body}
`,
    "utf8",
  );

  const command = join(dir, isWindows ? "cli.cmd" : "cli");
  if (isWindows) {
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  } else {
    writeFileSync(
      command,
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      "utf8",
    );
    chmodSync(command, 0o755);
  }
  return { command, recordPath, dir };
}

/** Exits 0 after printing `text` — the shape `claude --version` has. */
export function cliPrinting(text: string): FakeCli {
  return writeFakeCli(`process.stdout.write(${JSON.stringify(text)});`);
}

/** Exits non-zero with `stderr`, like an unauthenticated CLI. */
export function cliFailing(code: number, stderr: string): FakeCli {
  return writeFakeCli(
    `process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code});`,
  );
}

/** Never exits, so the caller's timeout is the thing under test. */
export function cliHanging(): FakeCli {
  return writeFakeCli(`setInterval(() => {}, 1000);`);
}

/** Emits a Claude-CLI-shaped `--output-format json` envelope around `result`. */
export function cliReturningJson(result: string): FakeCli {
  return writeFakeCli(
    `process.stdout.write(JSON.stringify({ result: ${JSON.stringify(result)} }));`,
  );
}

/** A path that does not exist, for the "CLI not installed" case. */
export function missingCliPath(): string {
  return join(tmpdir(), `inference-absent-${process.pid}`, "definitely-not-claude");
}

/** Every invocation the script recorded, in order. */
export function callsTo(cli: FakeCli): { argv: string[]; stdin: string }[] {
  try {
    return readFileSync(cli.recordPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; stdin: string });
  } catch {
    // No file means the script never ran — an empty call list, not an error.
    return [];
  }
}
