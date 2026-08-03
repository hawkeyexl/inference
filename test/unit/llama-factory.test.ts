import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  InferenceError,
  LLAMA_MODELS,
  makeProvider,
  makeProviderAsync,
  resolveProviderIdentity,
  resolveProviderIdentityAsync,
} from "../../src/index.js";
import type { LlamaRuntime, ProviderSpec } from "../../src/index.js";

/** A runtime that reports a fixed memory budget and loads nothing. */
function runtimeWithBudget(bytes: number): LlamaRuntime {
  return {
    resolveModelFile: (uri) => Promise.resolve(uri),
    loadModel: () => Promise.reject(new Error("not needed for identity")),
    getMemoryBudgetBytes: () => Promise.resolve(bytes),
  };
}

describe("llama-cpp defaults", () => {
  it("defaults to the auto selector", () => {
    expect(DEFAULT_MODELS["llama-cpp"]).toBe("auto");
  });

  it("lists llama-cpp in the unknown-provider error", () => {
    expect(() =>
      makeProvider({ provider: "nope" } as unknown as ProviderSpec),
    ).toThrow(/llama-cpp/);
  });
});

describe("synchronous resolution refuses selectors", () => {
  it("throws for the default spec, naming the async twin", () => {
    const spec: ProviderSpec = { provider: "llama-cpp" };
    expect(() => resolveProviderIdentity(spec)).toThrow(InferenceError);
    expect(() => resolveProviderIdentity(spec)).toThrow(
      /resolveProviderIdentityAsync/,
    );
  });

  it("throws from makeProvider too", () => {
    expect(() => makeProvider({ provider: "llama-cpp", model: "auto" })).toThrow(
      /makeProviderAsync/,
    );
  });

  it("still works synchronously for a concrete model", () => {
    expect(
      resolveProviderIdentity({ provider: "llama-cpp", model: "gemma-4-e4b" }),
    ).toEqual({ provider: "llama-cpp", model: "gemma-4-e4b" });
  });

  it("leaves the other providers untouched", () => {
    expect(resolveProviderIdentity({ provider: "anthropic" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });
});

describe("resolveProviderIdentityAsync", () => {
  it("resolves auto to a concrete alias, never the literal selector", async () => {
    const identity = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
      llamaRuntime: runtimeWithBudget(16 * 1e9),
    });
    expect(identity.provider).toBe("llama-cpp");
    expect(identity.model).toBe("gemma-4-e4b");
    expect(LLAMA_MODELS[identity.model]).toBeDefined();
  });

  it("picks a bigger model on a bigger machine", async () => {
    const big = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
      llamaRuntime: runtimeWithBudget(32 * 1e9),
    });
    const small = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
      llamaRuntime: runtimeWithBudget(4 * 1e9),
    });
    expect(big.model).toBe("gemma-4-12b");
    expect(small.model).toBe("gemma-4-e2b");
  });

  it("maps a tier keyword without probing hardware", async () => {
    const probed = { probed: false };
    const runtime: LlamaRuntime = {
      resolveModelFile: (uri) => Promise.resolve(uri),
      loadModel: () => Promise.reject(new Error("unused")),
      getMemoryBudgetBytes: () => {
        probed.probed = true;
        return Promise.resolve(0);
      },
    };
    const identity = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
      model: "quality",
      llamaRuntime: runtime,
    });
    expect(identity.model).toBe("gemma-4-12b");
    expect(probed.probed).toBe(false);
  });

  it("honours a runtime injected via llamaCpp as well as llamaRuntime", async () => {
    // makeProvider accepts both paths, so the selector probe must too —
    // otherwise it falls through to the real native module and throws for a
    // consumer whose whole point was to stay offline.
    const identity = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
      llamaCpp: { runtime: runtimeWithBudget(32 * 1e9) },
    });
    expect(identity.model).toBe("gemma-4-12b");
  });

  it("passes a concrete model straight through", async () => {
    const identity = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
      model: "hf:someone/Custom-GGUF/custom.gguf",
      llamaRuntime: runtimeWithBudget(0),
    });
    expect(identity.model).toBe("hf:someone/Custom-GGUF/custom.gguf");
  });

  it("delegates other providers to the sync form", async () => {
    expect(await resolveProviderIdentityAsync({ provider: "mock" })).toEqual({
      provider: "mock",
      model: "mock-model",
    });
  });
});

describe("makeProviderAsync", () => {
  it("builds a llama-cpp provider whose modelName matches the resolved identity", async () => {
    const spec: ProviderSpec = {
      provider: "llama-cpp",
      llamaRuntime: runtimeWithBudget(16 * 1e9),
    };
    const identity = await resolveProviderIdentityAsync(spec);
    const provider = await makeProviderAsync(spec);
    // The cache key and the model actually loaded must agree.
    expect(provider.modelName()).toBe(identity.model);
    expect(provider.provider()).toBe("llama-cpp");
  });

  it("builds the other providers exactly as makeProvider does", async () => {
    const provider = await makeProviderAsync({ provider: "mock" });
    expect(provider.provider()).toBe("mock");
    expect(provider.modelName()).toBe("mock-model");
  });
});
