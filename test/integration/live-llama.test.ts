/**
 * Live local-model check. Skipped unless INFERENCE_LIVE_LLAMA is set, so the
 * default suite stays offline — no network in tests is a hard rule here.
 *
 * The first run downloads the `fast` tier (~2.6 GB) to this library's own models
 * directory (`defaultLlamaModelsDirectory()`, overridable with
 * `INFERENCE_MODELS_DIR`) and needs `node-llama-cpp` installed, since it is an
 * optional peer dependency:
 *
 *   npm i node-llama-cpp
 *   INFERENCE_LIVE_LLAMA=1 npx vitest run test/integration/live-llama.test.ts
 */
import { describe, expect, it, afterAll } from "vitest";
import {
  LLAMA_MODELS,
  costOfRuns,
  disposeLlamaModels,
  judge,
  makeProviderAsync,
  pricingFor,
  resolveProviderIdentityAsync,
} from "../../src/index.js";

const live = process.env["INFERENCE_LIVE_LLAMA"] ? describe : describe.skip;

const SYSTEM = [
  "You are a meticulous judge. Evaluate whether the supplied text satisfies",
  "the assertion. Respond with a JSON object matching the provided schema.",
].join("\n");

// Weights load once per process and hold gigabytes; a download makes the first
// call slow. Generous, because the alternative is a flaky timeout.
const TIMEOUT = 900_000;

live("live llama-cpp provider", () => {
  afterAll(async () => {
    await disposeLlamaModels();
  });

  it("resolves auto to a concrete catalog model on this machine", async () => {
    const identity = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
    });
    expect(identity.provider).toBe("llama-cpp");
    // Never the literal selector — that is what the cache key records.
    expect(identity.model).not.toBe("auto");
    expect(LLAMA_MODELS[identity.model]).toBeDefined();
  }, 60_000);

  it("returns a schema-valid verdict for a clearly passing case", async () => {
    const provider = await makeProviderAsync({
      provider: "llama-cpp",
      model: "fast",
    });
    expect(provider.modelName()).toBe("gemma-4-e2b");

    const consensus = await judge({
      provider,
      system: SYSTEM,
      user: "# Assertion\nThe text mentions a cat.\n\n# Text\nThe cat sat on the mat.",
      runs: 1,
    });

    expect(consensus.runs[0]?.error).toBeUndefined();
    expect(consensus.verdict).toBe("pass");
    expect(consensus.runs[0]?.usage?.inputTokens).toBeGreaterThan(0);
    expect(consensus.runs[0]?.usage?.outputTokens).toBeGreaterThan(0);
  }, TIMEOUT);

  it("runs a 3-run ensemble that costs nothing", async () => {
    const provider = await makeProviderAsync({
      provider: "llama-cpp",
      model: "fast",
    });
    const consensus = await judge({
      provider,
      system: SYSTEM,
      user: "# Assertion\nThe text mentions a dog.\n\n# Text\nThe cat sat on the mat.",
      runs: 3,
    });

    expect(consensus.runs).toHaveLength(3);
    for (const run of consensus.runs) expect(run.error).toBeUndefined();
    // Local inference has no price entry, so cost is 0 rather than a guess.
    expect(pricingFor(provider.modelName())).toBeUndefined();
    expect(costOfRuns(consensus.runs, pricingFor(provider.modelName()))).toBe(0);
  }, TIMEOUT);
});
