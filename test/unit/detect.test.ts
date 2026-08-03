import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InferenceError,
  LLAMA_MODELS,
  availableProviders,
  detectProvider,
  makeProviderAsync,
  resetProviderDetectionWarning,
  resolveProviderIdentity,
  resolveProviderIdentityAsync,
  resetLlamaCliProbe,
} from "../../src/index.js";
import type { ExecFn, LlamaRuntime, ProviderSpec } from "../../src/index.js";

/** A claude CLI that is / is not installed. */
function cliExec(installed: boolean): ExecFn {
  return () =>
    Promise.resolve(
      installed
        ? { code: 0, stdout: "1.2.3", stderr: "", timedOut: false }
        : {
            code: null,
            stdout: "",
            stderr: "",
            timedOut: false,
            spawnError: "ENOENT",
          },
    );
}

/** A llama runtime that is / is not usable. */
function llamaRuntime(available: boolean): LlamaRuntime {
  return {
    resolveModelFile: (uri) => Promise.resolve(uri),
    loadModel: () => Promise.reject(new Error("unused")),
    getMemoryBudgetBytes: () =>
      available
        ? Promise.resolve(16 * 1e9)
        : Promise.reject(
            new InferenceError("node-llama-cpp is not installed. npm i ..."),
          ),
  };
}

/** Nothing available unless a test opts in. */
function spec(over: Partial<ProviderSpec> = {}): ProviderSpec {
  return {
    exec: cliExec(false),
    llamaRuntime: llamaRuntime(false),
    ...over,
  } as ProviderSpec;
}

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  resetProviderDetectionWarning();
  resetLlamaCliProbe();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.restoreAllMocks();
});

describe("detectProvider priority", () => {
  it("prefers anthropic when its key is set", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    process.env["OPENAI_API_KEY"] = "k";
    expect(
      await detectProvider(
        spec({ exec: cliExec(true), llamaRuntime: llamaRuntime(true) }),
      ),
    ).toBe("anthropic");
  });

  it("falls to openai when anthropic has no key", async () => {
    process.env["OPENAI_API_KEY"] = "k";
    expect(
      await detectProvider(
        spec({ exec: cliExec(true), llamaRuntime: llamaRuntime(true) }),
      ),
    ).toBe("openai");
  });

  it("falls to claude-cli when neither API key is set", async () => {
    expect(
      await detectProvider(
        spec({ exec: cliExec(true), llamaRuntime: llamaRuntime(true) }),
      ),
    ).toBe("claude-cli");
  });

  it("falls to llama-cpp when nothing else is available", async () => {
    expect(await detectProvider(spec({ llamaRuntime: llamaRuntime(true) }))).toBe(
      "llama-cpp",
    );
  });

  it("counts a keyless openai server when baseUrl is given", async () => {
    expect(
      await detectProvider(spec({ baseUrl: "http://localhost:11434/v1" })),
    ).toBe("openai");
  });

  it("honours a custom apiKeyEnv", async () => {
    process.env["MY_KEY"] = "k";
    try {
      expect(await detectProvider(spec({ apiKeyEnv: "MY_KEY" }))).toBe(
        "anthropic",
      );
    } finally {
      delete process.env["MY_KEY"];
    }
  });

  it("ignores an empty-string key", async () => {
    process.env["ANTHROPIC_API_KEY"] = "";
    expect(
      await detectProvider(spec({ llamaRuntime: llamaRuntime(true) })),
    ).toBe("llama-cpp");
  });

  it("never auto-selects mock", async () => {
    // Mock returns `{ json: {} }` unless scripted, which would sail through as
    // a non-error result — the opposite of the never-coerce invariant.
    const all = await availableProviders(
      spec({ exec: cliExec(true), llamaRuntime: llamaRuntime(true) }),
    );
    expect(all).not.toContain("mock");
    expect(all).toEqual(["claude-cli", "llama-cpp"]);
  });
});

describe("when nothing is available", () => {
  it("throws an error naming every provider and why it failed", async () => {
    const error = await detectProvider(spec()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    const message = (error as Error).message;
    for (const name of ["anthropic", "openai", "claude-cli", "llama-cpp"]) {
      expect(message).toContain(name);
    }
    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).toContain("node-llama-cpp");
  });
});

describe("the claude-cli probe", () => {
  it("runs the configured command once and memoises the result", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (cmd) => {
      calls.push(cmd);
      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      });
    };
    await detectProvider(spec({ exec }));
    await detectProvider(spec({ exec }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("claude");
  });

  it("treats a timeout as unavailable rather than hanging detection", async () => {
    const exec: ExecFn = () =>
      Promise.resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      });
    expect(
      await detectProvider(spec({ exec, llamaRuntime: llamaRuntime(true) })),
    ).toBe("llama-cpp");
  });
});

describe("auto-detection through the factory", () => {
  it("resolves an omitted provider to a concrete one, never 'auto'", async () => {
    const identity = await resolveProviderIdentityAsync(
      spec({ llamaRuntime: llamaRuntime(true) }),
    );
    expect(identity.provider).toBe("llama-cpp");
    // The 16 GB budget the fake reports lands on the balanced tier.
    expect(identity.model).toBe("gemma-4-e4b");
  });

  it("treats an explicit 'auto' identically to omitting it", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const omitted = await resolveProviderIdentityAsync(spec());
    const explicit = await resolveProviderIdentityAsync(
      spec({ provider: "auto" }),
    );
    expect(explicit).toEqual(omitted);
  });

  it("builds a provider whose identity matches the resolved one", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const s = spec();
    const identity = await resolveProviderIdentityAsync(s);
    const provider = await makeProviderAsync(s);
    expect(provider.provider()).toBe(identity.provider);
    expect(provider.modelName()).toBe(identity.model);
  });

  it("leaves an explicit provider untouched", async () => {
    expect((await resolveProviderIdentityAsync({ provider: "mock" })).provider).toBe(
      "mock",
    );
  });
});

describe("the synchronous path refuses to guess", () => {
  it("throws for an omitted provider instead of returning undefined", async () => {
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
    const warn = vi.mocked(console.warn);
    await detectProvider(spec({ llamaRuntime: llamaRuntime(true) }));
    await detectProvider(spec({ llamaRuntime: llamaRuntime(true) }));
    const selection = warn.mock.calls.filter((c) =>
      String(c[0]).includes("auto-selected"),
    );
    expect(selection).toHaveLength(1);
    expect(String(selection[0]?.[0])).toContain("llama-cpp");
  });

  it("does not warn when the provider was explicit", async () => {
    await resolveProviderIdentityAsync({ provider: "mock" });
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("warns about the download size when weights are absent", async () => {
    const empty = mkdtempSync(join(tmpdir(), "inference-detect-"));
    await resolveProviderIdentityAsync(
      spec({
        llamaRuntime: llamaRuntime(true),
        llamaCpp: { modelsDirectory: empty },
      }),
    );
    const warned = vi
      .mocked(console.warn)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(warned).toMatch(/download/i);
    expect(warned).toContain("GB");
  });

  it("does not warn about a download when the weights are already there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inference-detect-"));
    // Must be the tier the fake's 16 GB budget actually resolves to.
    const uri = LLAMA_MODELS["gemma-4-e4b"]!.uri;
    const [, user] = /^hf:([^/]+)\//.exec(uri)!;
    writeFileSync(
      join(dir, `hf_${user}_${uri.split("/").pop()}`),
      Buffer.alloc(4),
    );
    await resolveProviderIdentityAsync(
      spec({
        llamaRuntime: llamaRuntime(true),
        llamaCpp: { modelsDirectory: dir },
      }),
    );
    const warned = vi
      .mocked(console.warn)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(warned).not.toMatch(/download/i);
  });
});
