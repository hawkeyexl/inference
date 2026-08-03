import { describe, expect, it } from "vitest";
import { ClaudeCliProvider } from "../../src/index.js";
import type { ExecFn, ExecOptions, ExecResult } from "../../src/index.js";

interface Call {
  cmd: string[];
  opts: ExecOptions;
}

function recordingExec(result: Partial<ExecResult>): {
  exec: ExecFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: ExecFn = (cmd, opts = {}) => {
    calls.push({ cmd, opts });
    return Promise.resolve({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...result,
    });
  };
  return { exec, calls };
}

const REQUEST = {
  system: "You are a judge.",
  user: "Evaluate this.",
  schema: { type: "object" },
  temperature: 0,
};

describe("ClaudeCliProvider", () => {
  it("pipes the prompt through stdin, never argv", async () => {
    // Regression guard: user content routinely exceeds the ~32K Windows
    // command-line limit. Passing it as an argument silently truncates or
    // fails to spawn, so the prompt must arrive on stdin.
    const { exec, calls } = recordingExec({
      stdout: JSON.stringify({ result: '{"ok":true}' }),
    });
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", "claude", exec);

    await provider.completeJSON({ ...REQUEST, user: "x".repeat(40000) });

    const call = calls[0]!;
    expect(call.opts.input).toContain("x".repeat(40000));
    expect(call.cmd.join(" ")).not.toContain("xxxx");
  });

  it("sends the system prompt as --append-system-prompt and the schema on stdin", async () => {
    const { exec, calls } = recordingExec({
      stdout: JSON.stringify({ result: '{"ok":true}' }),
    });
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", "claude", exec);

    await provider.completeJSON(REQUEST);

    const call = calls[0]!;
    expect(call.cmd).toContain("--append-system-prompt");
    expect(call.cmd[call.cmd.indexOf("--append-system-prompt") + 1]).toBe(
      REQUEST.system,
    );
    expect(call.opts.input).toContain(JSON.stringify(REQUEST.schema));
  });

  it("unwraps the --output-format json envelope", async () => {
    const { exec } = recordingExec({
      stdout: JSON.stringify({ result: '```json\n{"ok":true}\n```' }),
    });
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", "claude", exec);
    const response = await provider.completeJSON(REQUEST);
    expect(response.json).toEqual({ ok: true });
  });

  it("reports no usage — the CLI does not surface token counts", async () => {
    const { exec } = recordingExec({
      stdout: JSON.stringify({ result: "{}" }),
    });
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", "claude", exec);
    expect((await provider.completeJSON(REQUEST)).usage).toBeUndefined();
  });

  it("explains a spawn failure as a missing CLI", async () => {
    const { exec } = recordingExec({ code: null, spawnError: "ENOENT" });
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", "claude", exec);
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /is the Claude CLI installed/,
    );
  });

  it("surfaces a timeout", async () => {
    const { exec } = recordingExec({ code: null, timedOut: true });
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", "claude", exec);
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(/timed out/);
  });

  it("surfaces a nonzero exit with the tail of stderr", async () => {
    const { exec } = recordingExec({ code: 2, stderr: "auth required" });
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", "claude", exec);
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /exited 2: auth required/,
    );
  });

  it("rejects an envelope with no result field", async () => {
    const { exec } = recordingExec({ stdout: JSON.stringify({ other: 1 }) });
    const provider = new ClaudeCliProvider("claude-sonnet-4-5", "claude", exec);
    await expect(provider.completeJSON(REQUEST)).rejects.toThrow(
      /no result field/,
    );
  });
});
