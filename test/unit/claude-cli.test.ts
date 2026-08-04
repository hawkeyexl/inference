/**
 * The Claude CLI provider, driven against real spawned processes.
 *
 * Only one thing here is a stand-in: what a real `claude -p` would *return*,
 * because that call reaches Anthropic. The script printing it is a real
 * executable, so argv, stdin, exit codes, timeouts and the envelope parse are
 * all exercised for real through `realExec` — the same path production takes
 * (CLAUDE.md, real-machine verification).
 */
import { describe, expect, it } from "vitest";
import { ClaudeCliProvider } from "../../src/index.js";
import {
  callsTo,
  cliFailing,
  cliHanging,
  cliReturningJson,
  missingCliPath,
  writeFakeCli,
} from "../support/fake-cli.js";

const REQUEST = {
  system: "You are a judge.",
  user: "Evaluate this.",
  schema: { type: "object" },
  temperature: 0,
};

describe("ClaudeCliProvider", () => {
  it("pipes the prompt through stdin, never argv", async () => {
    // Regression guard with teeth: user content routinely exceeds the ~32K
    // Windows command-line limit. A recorded ExecFn would happily "accept" a
    // 40K argument that a real spawn cannot carry, so this pushes 40K through
    // an actual pipe to an actual process and reads back what it received.
    const cli = cliReturningJson('{"ok":true}');
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);

    const huge = "x".repeat(40_000);
    await provider.completeJSON({ ...REQUEST, user: huge });

    const call = callsTo(cli)[0]!;
    expect(call.stdin).toContain(huge);
    expect(call.argv.join(" ")).not.toContain("xxxx");
  }, 30_000);

  it("survives multi-byte UTF-8 straddling a pipe chunk boundary", async () => {
    // Only observable against a real pipe: a naive decoder splits a 3-byte
    // character across chunks and corrupts it.
    const cli = cliReturningJson('{"ok":true}');
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);
    const wide = "日本語テキスト".repeat(4_000);

    await provider.completeJSON({ ...REQUEST, user: wide });

    expect(callsTo(cli)[0]!.stdin).toContain(wide);
  }, 30_000);

  it("sends the system prompt as --append-system-prompt and the schema on stdin", async () => {
    const cli = cliReturningJson('{"ok":true}');
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);

    await provider.completeJSON(REQUEST);

    const { argv, stdin } = callsTo(cli)[0]!;
    expect(argv).toContain("--append-system-prompt");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe(REQUEST.system);
    expect(stdin).toContain(JSON.stringify(REQUEST.schema));
  }, 30_000);

  it("unwraps the --output-format json envelope", async () => {
    const cli = cliReturningJson('```json\n{"ok":true}\n```');
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);
    expect((await provider.completeJSON(REQUEST)).json).toEqual({ ok: true });
  }, 30_000);

  it("reports no usage — the CLI does not surface token counts", async () => {
    const cli = cliReturningJson("{}");
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);
    expect((await provider.completeJSON(REQUEST)).usage).toBeUndefined();
  }, 30_000);

  it("explains a real spawn failure as a missing CLI", async () => {
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", missingCliPath());
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /is the Claude CLI installed/,
    );
  }, 30_000);

  it("surfaces a timeout against a process that really hangs", async () => {
    const provider = new ClaudeCliProvider(
      "claude-sonnet-4-5",
      cliHanging().command,
      undefined,
      1_500,
    );
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(/timed out/);
  }, 30_000);

  it("surfaces a nonzero exit with the tail of stderr", async () => {
    const cli = cliFailing(2, "auth required");
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /exited 2: auth required/,
    );
  }, 30_000);

  it("rejects an envelope with no result field", async () => {
    const cli = writeFakeCli(
      `process.stdout.write(JSON.stringify({ other: 1 }));`,
    );
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /no result field/,
    );
  }, 30_000);

  it("names the Claude CLI when stdout is not JSON, and quotes what it printed", async () => {
    // A bare `SyntaxError: Unexpected token 'W'` reaches the end user of a
    // consuming CLI verbatim, naming neither the culprit nor the fix. Every
    // other failure in this provider explains itself; this one must too.
    const cli = writeFakeCli(
      `process.stdout.write("Welcome to Claude Code!\\n\\nPlease run /login to continue.");`,
    );
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);

    const error = await provider.completeJSON(REQUEST).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/Claude CLI printed non-JSON output/);
    expect(message).toMatch(/is it logged in/);
    // The excerpt is what lets a reader recognise a login prompt on sight.
    expect(message).toContain("Please run /login to continue.");
    // ...on one line, so it stays a log line rather than a wall of banner.
    expect(message).not.toContain("\n");
    expect(message).not.toMatch(/no result field/);
  }, 30_000);

  it("bounds the excerpt so a megabyte of HTML cannot become the error", async () => {
    // A proxy interception page is the realistic worst case here.
    const cli = writeFakeCli(
      `process.stdout.write("<html>" + "<div>blocked</div>".repeat(60000) + "</html>");`,
    );
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);

    const error = await provider.completeJSON(REQUEST).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/Claude CLI printed non-JSON output/);
    expect((error as Error).message.length).toBeLessThan(400);
  }, 30_000);

  it("says so when the CLI exits cleanly having printed nothing", async () => {
    const cli = writeFakeCli(`process.exit(0);`);
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", cli.command);

    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /Claude CLI printed non-JSON output .*: \(no output\)/,
    );
  }, 30_000);
});
