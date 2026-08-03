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
import { describe, expect, it } from "vitest";
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

/**
 * Probed once at module scope so `it.skipIf` can use it at collection time.
 * An early `return` inside a test reports as PASSED without asserting, which
 * hides that the check never ran — see the real-machine rule in CLAUDE.md.
 */
const realBudget = await defaultLlamaRuntime()
  .getMemoryBudgetBytes()
  .then(
    (b) => b,
    () => 0,
  );
const llamaUsable = realBudget > 0;

/** Runs only where the native binding works; reported as skipped elsewhere. */
const itWithLlama = it.skipIf(!llamaUsable);

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
  itWithLlama("reports a usable budget on a machine with the binding", () => {
    expect(realBudget).toBeGreaterThan(0);
    expect(Number.isFinite(realBudget)).toBe(true);
  });

  itWithLlama("resolves that budget to a real catalog tier", () => {
    const tier = tierForBudget(realBudget);
    expect(LLAMA_TIERS).toContain(tier);
    expect(LLAMA_MODELS[aliasForTier(tier)]).toBeDefined();
  });

  it("settles either way — never hangs, never throws synchronously", async () => {
    // The contract detection depends on, asserted on whichever branch this
    // machine takes rather than silently passing on the other.
    const outcome = await defaultLlamaRuntime()
      .getMemoryBudgetBytes()
      .then((b) => ({ ok: true as const, b }))
      .catch((e: unknown) => ({ ok: false as const, e }));
    if (outcome.ok) {
      expect(typeof outcome.b).toBe("number");
      expect(outcome.b).toBeGreaterThan(0);
    } else {
      expect(outcome.e).toBeInstanceOf(InferenceError);
      expect((outcome.e as Error).message).toMatch(/node-llama-cpp/);
    }
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
  itWithLlama("resolves auto to a concrete catalog alias on this machine", async () => {
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
  itWithLlama("builds a llama-cpp provider whose modelName matches the resolved identity", async () => {
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
