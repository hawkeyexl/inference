/**
 * Provider detection, verified against the real machine.
 *
 * The Claude CLI probe spawns actual processes; the llama-cpp probe loads the
 * actual `node-llama-cpp` binding; the key probes read the actual environment.
 * Nothing here is faked, because none of it is a third-party network call —
 * and the fakes this file used to carry are exactly what hid a ~987ms eager
 * probe and a memo that ignored the command (CLAUDE.md, real-machine
 * verification).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETECTION_ORDER,
  InferenceError,
  LLAMA_MODELS,
  availableProviders,
  defaultLlamaRuntime,
  detectProvider,
  makeProviderAsync,
  resetClaudeCliProbe,
  resetProviderDetectionWarning,
  resolveProviderIdentity,
  resolveProviderIdentityAsync,
} from "../../src/index.js";
import type { ProviderSpec } from "../../src/index.js";
import {
  callsTo,
  cliPrinting,
  missingCliPath,
} from "../support/fake-cli.js";

/**
 * Is the optional native binding usable here? Answered once, at module scope,
 * by asking the real runtime.
 *
 * Resolved before collection so `it.skipIf` can use it: a test that instead
 * early-returns is reported as PASSED without having asserted anything, which
 * is exactly the "green means verified" illusion the real-machine rule exists
 * to prevent. Skipped is honest; silently passing is not.
 */
const llamaUsable = await defaultLlamaRuntime()
  .getMemoryBudgetBytes()
  .then(
    () => true,
    () => false,
  );

/** Runs only where the native binding works; reported as skipped elsewhere. */
const itWithLlama = it.skipIf(!llamaUsable);
/** Runs only where it does NOT, which is the only place the aggregate error is reachable. */
const itWithoutLlama = it.skipIf(llamaUsable);

/** Base spec whose CLI is genuinely absent, so only real signals decide. */
function spec(over: Partial<ProviderSpec> = {}): ProviderSpec {
  return { command: missingCliPath(), ...over } as ProviderSpec;
}

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  resetProviderDetectionWarning();
  resetClaudeCliProbe();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.restoreAllMocks();
});

const warnings = (): string =>
  vi
    .mocked(console.warn)
    .mock.calls.map((c) => String(c[0]))
    .join("\n");

describe("detection priority", () => {
  it("prefers anthropic when its key is set", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    process.env["OPENAI_API_KEY"] = "k";
    expect(await detectProvider(spec({ command: cliPrinting("1").command }))).toBe(
      "anthropic",
    );
  }, 30_000);

  it("falls to openai when anthropic has no key", async () => {
    process.env["OPENAI_API_KEY"] = "k";
    expect(await detectProvider(spec({ command: cliPrinting("1").command }))).toBe(
      "openai",
    );
  }, 30_000);

  it("falls to a real, runnable CLI when neither API key is set", async () => {
    const cli = cliPrinting("1.2.3");
    expect(await detectProvider(spec({ command: cli.command }))).toBe(
      "claude-cli",
    );
    // It really ran the executable, with the argument the probe claims to use.
    expect(callsTo(cli)[0]?.argv).toEqual(["--version"]);
  }, 30_000);

  it("skips a CLI that is genuinely not installed", async () => {
    const picked = await detectProvider(spec()).catch(() => "none");
    // Never the CLI — the executable genuinely does not exist. What it falls
    // through to depends on whether this machine has the native binding.
    expect(picked).not.toBe("claude-cli");
    expect(picked).toBe(llamaUsable ? "llama-cpp" : "none");
  }, 30_000);

  it("counts a keyless openai server when baseUrl is given", async () => {
    expect(await detectProvider(spec({ baseUrl: "http://localhost:11434/v1" }))).toBe(
      "openai",
    );
  }, 30_000);

  it("does not let a custom apiKeyEnv decide the provider", async () => {
    // One field is shared by both API providers and detection only runs when
    // none was named, so a custom name cannot say which it belongs to.
    // Honouring it made an OpenAI key select anthropic, which then 401s.
    process.env["MY_OPENAI_KEY"] = "sk-openai";
    try {
      const picked = await detectProvider(
        spec({ apiKeyEnv: "MY_OPENAI_KEY" }),
      ).catch(() => "none");
      expect(picked).not.toBe("anthropic");
    } finally {
      delete process.env["MY_OPENAI_KEY"];
    }
  }, 30_000);

  it("ignores an empty-string key", async () => {
    process.env["ANTHROPIC_API_KEY"] = "";
    const picked = await detectProvider(spec()).catch(() => "none");
    expect(picked).not.toBe("anthropic");
  }, 30_000);

  it("never auto-selects mock", async () => {
    // Mock answers `{ json: {} }` unless scripted, which would sail through as
    // a non-error result — the opposite of the never-coerce invariant.
    expect(DETECTION_ORDER).not.toContain("mock");
    process.env["ANTHROPIC_API_KEY"] = "k";
    expect(await availableProviders(spec())).not.toContain("mock");
  }, 30_000);
});

describe("probe cost", () => {
  it("stops at the first hit instead of running the expensive probes", async () => {
    // Measured against the real machine, not a fake that made them free: the
    // CLI spawn is ~150ms and loading the llama binding ~850ms, the latter also
    // initialising the backend and allocating GPU context. Selecting anthropic
    // off an env var must touch neither.
    process.env["ANTHROPIC_API_KEY"] = "k";
    const cli = cliPrinting("1");
    const started = Date.now();
    expect(await detectProvider(spec({ command: cli.command }))).toBe("anthropic");
    const elapsed = Date.now() - started;

    // The definitive check: the real executable was never spawned.
    expect(callsTo(cli)).toHaveLength(0);
    // And it returned far faster than any subprocess or native load could.
    expect(elapsed).toBeLessThan(100);
  }, 30_000);

  it("availableProviders does probe everything, since it reports the full list", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const cli = cliPrinting("1");
    const all = await availableProviders(spec({ command: cli.command }));
    expect(all).toContain("anthropic");
    expect(all).toContain("claude-cli");
    expect(callsTo(cli)).toHaveLength(1);
  }, 30_000);
});

describe("the Claude CLI probe", () => {
  it("spawns once per command and reuses the result", async () => {
    const cli = cliPrinting("1.2.3");
    await detectProvider(spec({ command: cli.command }));
    await detectProvider(spec({ command: cli.command }));
    expect(callsTo(cli)).toHaveLength(1);
  }, 30_000);

  it("re-probes when a different command is named", async () => {
    // Memoising on a single key made a fallback to an absolute path inherit
    // the bare command's failure and silently drop to the local model.
    const working = cliPrinting("1.2.3");
    expect(await availableProviders(spec())).not.toContain("claude-cli");
    expect(
      await availableProviders(spec({ command: working.command })),
    ).toContain("claude-cli");
  }, 30_000);

  it("treats a CLI that exits non-zero as unavailable", async () => {
    const { cliFailing } = await import("../support/fake-cli.js");
    const cli = cliFailing(1, "not authenticated");
    expect(await availableProviders(spec({ command: cli.command }))).not.toContain(
      "claude-cli",
    );
  }, 30_000);
});

describe("when nothing is available", () => {
  itWithoutLlama("names every provider and why each failed", async () => {
    const error = await detectProvider(spec()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    const message = (error as Error).message;
    for (const name of DETECTION_ORDER) expect(message).toContain(name);
    expect(message).toContain("ANTHROPIC_API_KEY");
  }, 30_000);
});

describe("resolution through the factory", () => {
  it("resolves an omitted provider to a concrete one, never 'auto'", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const identity = await resolveProviderIdentityAsync(spec());
    expect(identity.provider).toBe("anthropic");
    expect(identity.model).toBe("claude-sonnet-4-5");
  }, 30_000);

  it("treats an explicit 'auto' identically to omitting it", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const omitted = await resolveProviderIdentityAsync(spec());
    resetProviderDetectionWarning();
    resetClaudeCliProbe();
    const explicit = await resolveProviderIdentityAsync(
      spec({ provider: "auto" }),
    );
    expect(explicit).toEqual(omitted);
  }, 30_000);

  it("builds a provider whose identity matches the resolved one", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const s = spec();
    const identity = await resolveProviderIdentityAsync(s);
    const provider = await makeProviderAsync(s);
    expect(provider.provider()).toBe(identity.provider);
    expect(provider.modelName()).toBe(identity.model);
  }, 30_000);

  it("leaves an explicit provider untouched", async () => {
    expect(
      (await resolveProviderIdentityAsync({ provider: "mock" })).provider,
    ).toBe("mock");
  });
});

describe("the synchronous path refuses to guess", () => {
  it("throws for an omitted provider instead of returning undefined", () => {
    // It used to return { provider: undefined, model: "unknown" } — cache-key
    // material that two different malformed specs would collide on.
    expect(() => resolveProviderIdentity({} as ProviderSpec)).toThrow(
      InferenceError,
    );
    expect(() => resolveProviderIdentity({} as ProviderSpec)).toThrow(
      /resolveProviderIdentityAsync/,
    );
  });

  it("throws for an explicit 'auto'", () => {
    expect(() =>
      resolveProviderIdentity({ provider: "auto" } as ProviderSpec),
    ).toThrow(/resolveProviderIdentityAsync/);
  });
});

describe("warnings", () => {
  it("names the auto-selected provider once per process", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    await detectProvider(spec());
    await detectProvider(spec());
    const selection = vi
      .mocked(console.warn)
      .mock.calls.filter((c) => String(c[0]).includes("auto-selected"));
    expect(selection).toHaveLength(1);
    expect(String(selection[0]?.[0])).toContain("anthropic");
  }, 30_000);

  it("does not warn when the provider was explicit", async () => {
    await resolveProviderIdentityAsync({ provider: "mock" });
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("does not claim 'no provider specified' when auto was explicit", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    await detectProvider(spec({ provider: "auto" }));
    expect(warnings()).not.toMatch(/no provider specified/);
    expect(warnings()).toContain('provider "auto"');
  }, 30_000);

  itWithLlama("does not warn about a download while only resolving an identity", async () => {
    // Identity resolution is the fully-cached path — it constructs nothing and
    // downloads nothing, so announcing gigabytes there is simply false.
    const empty = mkdtempSync(join(tmpdir(), "inference-detect-"));
    await resolveProviderIdentityAsync(
      spec({ llamaCpp: { modelsDirectory: empty } }),
    );
    expect(warnings()).not.toMatch(/download|fetch/i);
  }, 60_000);

  itWithLlama("warns with the real size when weights are absent at construction", async () => {
    const empty = mkdtempSync(join(tmpdir(), "inference-detect-"));
    await makeProviderAsync(spec({ llamaCpp: { modelsDirectory: empty } }));
    expect(warnings()).toMatch(/download|fetch/i);
    expect(warnings()).toContain("GB");
  }, 60_000);

  itWithLlama("does not warn about a download when the weights are really on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inference-detect-"));
    // Resolve what this machine actually picks, then put that file there.
    const { model } = await resolveProviderIdentityAsync(
      spec({ llamaCpp: { modelsDirectory: dir } }),
    );
    const uri = LLAMA_MODELS[model]!.uri;
    const [, user] = /^hf:([^/]+)\//.exec(uri)!;
    writeFileSync(join(dir, `hf_${user}_${uri.split("/").pop()}`), Buffer.alloc(4));
    resetProviderDetectionWarning();
    await makeProviderAsync(spec({ llamaCpp: { modelsDirectory: dir } }));
    expect(warnings()).not.toMatch(/download|fetch/i);
  }, 60_000);
});
