import { describe, expect, it } from "vitest";
import { realExec } from "../../src/index.js";

const NODE = process.execPath;

describe("realExec", () => {
  it("captures stdout and the exit code", async () => {
    const result = await realExec([NODE, "-e", "process.stdout.write('hi')"]);
    expect(result.stdout).toBe("hi");
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr and a nonzero exit code", async () => {
    const result = await realExec([
      NODE,
      "-e",
      "process.stderr.write('bad'); process.exit(3)",
    ]);
    expect(result.stderr).toBe("bad");
    expect(result.code).toBe(3);
  });

  it("pipes input to the child's stdin", async () => {
    const result = await realExec(
      [
        NODE,
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.length.toString()))",
      ],
      { input: "x".repeat(40000) },
    );
    expect(result.stdout).toBe("40000");
  });

  it("decodes multi-byte UTF-8 that straddles chunk boundaries", async () => {
    const result = await realExec([
      NODE,
      "-e",
      "process.stdout.write('é'.repeat(50000))",
    ]);
    expect(result.stdout).toBe("é".repeat(50000));
  });

  it("reports a spawn failure instead of throwing", async () => {
    const result = await realExec(["definitely-not-a-real-binary-xyz"]);
    expect(result.spawnError).toBeDefined();
    expect(result.code).toBeNull();
  });

  it("reports an empty command", async () => {
    expect((await realExec([])).spawnError).toBe("Empty command");
  });

  it("times out a hanging child", async () => {
    const result = await realExec([NODE, "-e", "setTimeout(()=>{}, 60000)"], {
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
  });
});
