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

  it("passes env overrides to the child", async () => {
    const result = await realExec(
      [NODE, "-e", "process.stdout.write(process.env.DOCKG_PROBE ?? 'unset')"],
      { env: { DOCKG_PROBE: "set" } },
    );
    expect(result.stdout).toBe("set");
  });

  it("unsets an inherited variable when its override is undefined", async () => {
    // Clearing inherited state (a caller stripping GIT_* before shelling out
    // to git, say) needs unset, not empty-string — the two are not the same to
    // most tools. Node omits undefined-valued keys from the child env.
    process.env["INFERENCE_PROBE"] = "inherited";
    try {
      const result = await realExec(
        [
          NODE,
          "-e",
          "process.stdout.write('INFERENCE_PROBE' in process.env ? 'present' : 'absent')",
        ],
        { env: { INFERENCE_PROBE: undefined } },
      );
      expect(result.stdout).toBe("absent");
    } finally {
      delete process.env["INFERENCE_PROBE"];
    }
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

  it("settles on timeout even when the child ignores SIGTERM", async () => {
    // On POSIX a child with a SIGTERM handler survives child.kill(), so
    // 'close' never fires. Settling only on 'close' would hang the caller
    // forever with no timeout error.
    const result = await realExec(
      [
        NODE,
        "-e",
        "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)",
      ],
      { timeoutMs: 500 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  }, 5000);
});
