/**
 * Selector resolution through the factory, against the real runtime.
 *
 * Tier boundaries are pinned by `tierForBudget` in `llama-models.test.ts`,
 * which is a pure function and needs no machine at all. What matters *here* is
 * the part a fake cannot tell you: that the real binding produces a real budget
 * which resolves to a real catalog entry, and that the identity a caller
 * caches on is the one the provider actually loads.
 *
 * These assert contracts rather than values, so they stay honest on a runner
 * where the optional native binding is absent.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  InferenceError,
  LLAMA_MODELS,
  LLAMA_TIERS,
  aliasForTier,
  defaultLlamaRuntime,
  makeProvider,
  makeProviderAsync,
  resolveProviderIdentity,
  resolveProviderIdentityAsync,
  tierForBudget,
} from "../../src/index.js";
import type { ProviderSpec } from "../../src/index.js";

let llamaUsable = false;
let realBudget = 0;

beforeAll(async () => {
  await defaultLlamaRuntime()
    .getMemoryBudgetBytes()
    .then(
      (b) => {
        llamaUsable = true;
        realBudget = b;
      },
      () => undefined,
    );
});

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

describe("the real memory probe", () => {
  it("reports a usable budget on a machine with the binding", () => {
    if (!llamaUsable) return;
    expect(realBudget).toBeGreaterThan(0);
    expect(Number.isFinite(realBudget)).toBe(true);
  });

  it("resolves that budget to a real catalog tier", () => {
    if (!llamaUsable) return;
    const tier = tierForBudget(realBudget);
    expect(LLAMA_TIERS).toContain(tier);
    expect(LLAMA_MODELS[aliasForTier(tier)]).toBeDefined();
  });

  it("reports unavailability as a rejection, never a hang or a crash", async () => {
    // The contract the detection probe depends on: this either resolves with a
    // number or rejects with an actionable error — it never throws synchronously.
    const outcome = await defaultLlamaRuntime()
      .getMemoryBudgetBytes()
      .then(() => "resolved" as const)
      .catch((e: unknown) => e);
    if (outcome === "resolved") return;
    expect(outcome).toBeInstanceOf(InferenceError);
    expect((outcome as Error).message).toMatch(/node-llama-cpp/);
  }, 30_000);
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

describe("asynchronous resolution", () => {
  it("resolves auto to a concrete catalog alias on this machine", async () => {
    if (!llamaUsable) return;
    const identity = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
    });
    expect(identity.provider).toBe("llama-cpp");
    // Never the literal selector — that is what the cache key records.
    expect(identity.model).not.toBe("auto");
    expect(LLAMA_MODELS[identity.model]).toBeDefined();
    // And it agrees with what the real budget implies.
    expect(identity.model).toBe(aliasForTier(tierForBudget(realBudget)));
  }, 30_000);

  it("maps a tier keyword without consulting the machine", async () => {
    // No native binding needed: a named tier is a catalog lookup.
    expect(
      (
        await resolveProviderIdentityAsync({
          provider: "llama-cpp",
          model: "quality",
        })
      ).model,
    ).toBe("gemma-4-12b");
  });

  it("passes a concrete model straight through", async () => {
    const identity = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
      model: "hf:someone/Custom-GGUF/custom.gguf",
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
    if (!llamaUsable) return;
    const spec: ProviderSpec = { provider: "llama-cpp" };
    const identity = await resolveProviderIdentityAsync(spec);
    const provider = await makeProviderAsync(spec);
    // The cache key and the model actually loaded must agree.
    expect(provider.modelName()).toBe(identity.model);
    expect(provider.provider()).toBe("llama-cpp");
  }, 30_000);

  it("builds the other providers exactly as makeProvider does", async () => {
    const provider = await makeProviderAsync({ provider: "mock" });
    expect(provider.provider()).toBe("mock");
    expect(provider.modelName()).toBe("mock-model");
  });
});
