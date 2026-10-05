/**
 * Live local-model check. Skipped unless INFERENCE_LIVE_LLAMA is set, so the
 * default suite stays offline — no network in tests is a hard rule here.
 *
 * The first run downloads the `fast` tier (~1.4 GB) to this library's own models
 * directory (`defaultLlamaModelsDirectory()`, overridable with
 * `INFERENCE_MODELS_DIR`) and needs `node-llama-cpp` installed, since it is an
 * optional peer dependency:
 *
 *   npm i node-llama-cpp
 *   INFERENCE_LIVE_LLAMA=1 npx vitest run test/integration/live-llama.test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { setModelHostEntry } from "../../src/providers/model-host.js";
import {
  InferenceError,
  LLAMA_MODELS,
  LlamaCppProvider,
  aliasForTier,
  canDecide,
  costOfRuns,
  defaultLlamaModelsDirectory,
  defaultLlamaRuntime,
  disposeLlamaModels,
  judge,
  makeProviderAsync,
  modelHostStatus,
  pricingFor,
  releaseModelHost,
  resolveLlamaModelRef,
  resolveProviderIdentityAsync,
} from "../../src/index.js";
import type { LlamaDecideResult, LlamaRuntime } from "../../src/index.js";

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
    // The tier's alias, not a literal: ADR 01009 retiered the catalog and a
    // hard-coded name went stale without failing anything run by default.
    expect(provider.modelName()).toBe(aliasForTier("fast"));

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

  // The shape that hid a real defect for a whole release. Grammar-constrained
  // generation can return `result.text` without its opening `{`, and with an
  // array in the payload the old brace-slicing fallback latched onto the first
  // *element's* brace instead — so `completeJSON` failed with
  // "Unexpected non-whitespace character after JSON at position 100" on every
  // call. Every unit fixture fed text that already had the brace, so only real
  // weights could show it. Consumers use exactly this shape: docmeta's `fill`
  // asks for an array of proposals.
  it("returns a schema-valid object whose payload is an array", async () => {
    const provider = await makeProviderAsync({
      provider: "llama-cpp",
      model: "fast",
    });
    const result = await provider.completeJSON({
      system: "Extract every animal the text mentions.",
      user: "The cat sat on the mat. A dog watched.",
      schema: {
        type: "object",
        required: ["animals"],
        properties: {
          animals: {
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          },
        },
      },
      temperature: 0,
    });
    const json = result.json as { animals?: { name?: string }[] };
    expect(Array.isArray(json.animals)).toBe(true);
    expect(json.animals?.length).toBeGreaterThan(0);
  }, TIMEOUT);

  // The memory bug: node-llama-cpp's own default sizes the context to free
  // memory, which reserved all 131072 trained tokens of granite-4.1-3b-q2 on
  // CPU — about 11 GB for a one-field prompt. Recorded here from the context
  // the real binding actually created, not from the size the provider asked
  // for. ADR 01011.
  describe("context size, against the real binding", () => {
    /** The real runtime, recording each session's created context size. */
    function recordingRuntime(): { runtime: LlamaRuntime; sizes: number[] } {
      const sizes: number[] = [];
      const real = defaultLlamaRuntime();
      const runtime: LlamaRuntime = {
        ...real,
        async loadModel(path) {
          const model = await real.loadModel(path);
          return {
            ...model,
            async createSession(systemPrompt, contextSize) {
              const session = await model.createSession(systemPrompt, contextSize);
              if (session.contextSize != null) sizes.push(session.contextSize);
              return session;
            },
          };
        },
      };
      return { runtime, sizes };
    }

    it("creates at most 8192 tokens of context for a small prompt", async () => {
      // Loaded weights are shared process-wide, so an earlier test's model
      // would bypass this runtime's createSession. Start from none.
      await disposeLlamaModels();
      const { runtime, sizes } = recordingRuntime();
      const provider = new LlamaCppProvider("granite-4.1-3b-q2", { runtime });
      const result = await provider.completeJSON({
        system: "Propose a value for the one missing metadata field.",
        user: "# Choosing a model\n\nWhat auto picks, and how to override it.",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
        temperature: 0,
      });
      expect(typeof (result.json as { title?: unknown }).title).toBe("string");
      expect(sizes).toHaveLength(1);
      expect(sizes[0]).toBeGreaterThan(0);
      expect(sizes[0]).toBeLessThanOrEqual(8192);
    }, TIMEOUT);

    it("reports the trained context and counts tokens with the model's tokenizer", async () => {
      const real = defaultLlamaRuntime();
      const path = await real.resolveModelFile(
        resolveLlamaModelRef("granite-4.1-3b-q2"),
        defaultLlamaModelsDirectory(),
      );
      const model = await real.loadModel(path);
      try {
        expect(model.trainContextSize).toBe(131_072);
        // Async since ADR 01012: the tokenizer lives in the worker process.
        const count = await model.countTokens?.("The cat sat on the mat.");
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThan(20);
      } finally {
        await model.dispose();
      }
    }, TIMEOUT);

    it("refuses a prompt longer than the trained context instead of truncating it", async () => {
      await disposeLlamaModels();
      const { runtime, sizes } = recordingRuntime();
      const provider = new LlamaCppProvider("granite-4.1-3b-q2", { runtime });
      const error: unknown = await provider
        .completeJSON({
          system: "Summarise.",
          // Comfortably past 131072 tokens with any tokenizer.
          user: "The cat sat on the mat. ".repeat(40_000),
          schema: { type: "object", properties: { s: { type: "string" } } },
          temperature: 0,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InferenceError);
      expect((error as Error).message).toMatch(/training context of 131072 tokens/);
      expect(sizes).toEqual([]);
    }, TIMEOUT);
  });

  // Decisions read the model's next-token probabilities over option letters.
  // Only real weights show whether the template's thinking is really off (a
  // thought block would take the mass a letter should get) and which way the
  // sequence returns to the shared state between questions: Qwen3.5 is a
  // hybrid model, so it cannot simply erase. ADR 01016.
  describe("decisions, against the real binding", () => {
    const model = process.env["INFERENCE_LIVE_DECIDE_MODEL"] ?? "qwen3.5-4b";

    function recordingRuntime(): { runtime: LlamaRuntime; results: LlamaDecideResult[] } {
      const results: LlamaDecideResult[] = [];
      const real = defaultLlamaRuntime();
      return {
        results,
        runtime: {
          ...real,
          async loadModel(path) {
            const loaded = await real.loadModel(path);
            return {
              ...loaded,
              async createSession(systemPrompt, contextSize) {
                const session = await loaded.createSession(systemPrompt, contextSize);
                return {
                  ...session,
                  async decide(options) {
                    const result = await session.decide!(options);
                    results.push(result);
                    return result;
                  },
                };
              },
            };
          },
        },
      };
    }

    it("answers clear questions with the right option, reusing the shared state", async () => {
      await disposeLlamaModels();
      const { runtime, results } = recordingRuntime();
      const provider = new LlamaCppProvider(model, { runtime });
      expect(canDecide(provider)).toBe(true);
      const request = {
        state:
          "The cat sat on the mat. Then the agent ran `git commit --no-verify`, " +
          "which skips the repository's pre-commit hook.",
        questions: {
          animal: {
            type: "choice" as const,
            instructions: "Which animal does the state mention?",
            criteria: { dog: "A dog.", cat: "A cat.", bird: "A bird." },
          },
          hooks: {
            type: "choice" as const,
            instructions: "Did the agent skip a git hook?",
            criteria: { yes: "Yes, it skipped one.", no: "No, it ran every hook." },
          },
          weather: {
            type: "choice" as const,
            instructions: "Does the state say it was raining?",
            criteria: { yes: "Yes.", no: "No, the state says nothing about rain." },
          },
        },
      };
      await provider.decide(request); // loads the weights; not timed
      const started = performance.now();
      const response = await provider.decide(request);
      const elapsed = performance.now() - started;
      const result = results[1]!;
      console.log(
        `decide on ${model}: ${elapsed.toFixed(0)} ms for 3 questions ` +
          `(${(elapsed / 3).toFixed(0)} ms each), reuse ${String(result.reuse)}, ` +
          `${String(response.usage?.inputTokens)} input tokens`,
      );

      expect(response.answers["animal"]!.choice).toBe("cat");
      expect(response.answers["hooks"]!.choice).toBe("yes");
      expect(response.answers["weather"]!.choice).toBe("no");
      for (const answer of Object.values(response.answers)) {
        expect(answer.confidence).toBeGreaterThan(0.5);
      }
      // Most of the model's next-token mass is on the letters: it answered,
      // rather than opening a thought block or restating the question.
      for (const weights of result.weights) {
        const mass = Object.values(weights).reduce((sum, p) => sum + p, 0);
        expect(mass).toBeGreaterThan(0.5);
      }
      expect(["erase", "checkpoint", "reevaluate"]).toContain(result.reuse);
      expect(response.usage?.outputTokens).toBe(0);
    }, TIMEOUT);

    it("reports a state limit inside the training context", async () => {
      const provider = new LlamaCppProvider(model);
      const limit = await provider.stateLimit();
      expect(limit).toBeGreaterThan(8192);
      // Qwen3.5 and Granite 4.1 train on 262144 and 131072 tokens.
      expect(limit).toBeLessThan(262_144);
    }, TIMEOUT);
  });

  // The host from source, as the unit suite runs it, but over the real binding.
  // INFERENCE_LIVE_HOST_MODEL picks the model; it defaults to the balanced tier.
  describe("the model host, against the real binding", () => {
    const hostModel = process.env["INFERENCE_LIVE_HOST_MODEL"] || aliasForTier("balanced");
    const savedRuntimeDir = process.env["INFERENCE_RUNTIME_DIR"];

    beforeAll(() => {
      process.env["INFERENCE_RUNTIME_DIR"] = mkdtempSync(join(tmpdir(), "inference-live-host-"));
      setModelHostEntry({
        path: resolve("src/providers/llama-hostd.ts"),
        execArgv: [
          "--import",
          pathToFileURL(resolve("test/support/ts-hooks.mjs")).href,
          "--experimental-transform-types",
          "--disable-warning=ExperimentalWarning",
        ],
      });
    });

    afterAll(async () => {
      await releaseModelHost({ all: true });
      setModelHostEntry(undefined);
      if (savedRuntimeDir === undefined) delete process.env["INFERENCE_RUNTIME_DIR"];
      else process.env["INFERENCE_RUNTIME_DIR"] = savedRuntimeDir;
    }, 60_000);

    it("loads once, and answers a second client from the loaded model", async () => {
      const call = async (): Promise<number> => {
        const started = performance.now();
        const provider = new LlamaCppProvider(hostModel, { host: "spawn" });
        const consensus = await judge({
          provider,
          system: SYSTEM,
          user: "# Assertion\nThe text mentions a cat.\n\n# Text\nThe cat sat on the mat.",
          runs: 1,
        });
        expect(consensus.runs[0]?.error).toBeUndefined();
        expect(consensus.verdict).toBe("pass");
        return performance.now() - started;
      };
      const first = await call();
      const second = await call();
      console.log(
        `model host, ${hostModel}: first call ${Math.round(first)} ms ` +
          `(start + load), second client ${Math.round(second)} ms`,
      );
      // No timing assertion: a CUDA crash mid-run (ADR 01012) makes the host
      // reload on Vulkan, and the second call then pays for a load too.
      const status = await modelHostStatus();
      expect(status?.models.map((m) => m.model)).toEqual([hostModel]);
    }, TIMEOUT);
  });

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
