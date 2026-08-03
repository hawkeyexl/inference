/**
 * Live provider check. Skipped unless ANTHROPIC_API_KEY is set, so the default
 * suite stays offline — no network in tests is a hard rule across these repos.
 *
 * Run it with:  ANTHROPIC_API_KEY=... npm test
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonCache,
  buildCacheKey,
  costOfRuns,
  judge,
  makeProvider,
  pricingFor,
  runEnsemble,
  type JudgeRun,
} from "../../src/index.js";

const live = process.env["ANTHROPIC_API_KEY"] ? describe : describe.skip;

const SYSTEM = [
  "You are a meticulous judge. Evaluate whether the supplied text satisfies",
  "the assertion. Respond with a JSON object matching the provided schema.",
].join("\n");

live("live Anthropic provider", () => {
  it("returns a schema-valid verdict for a clearly passing case", async () => {
    const provider = makeProvider({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    const consensus = await judge({
      provider,
      system: SYSTEM,
      user: "# Assertion\nThe text mentions a cat.\n\n# Text\nThe cat sat on the mat.",
      runs: 1,
    });
    expect(consensus.runs[0]?.error).toBeUndefined();
    expect(consensus.verdict).toBe("pass");
    expect(consensus.runs[0]?.usage?.inputTokens).toBeGreaterThan(0);
  }, 60000);

  it("caches an ensemble so the second run makes no call and costs nothing", async () => {
    const provider = makeProvider({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    const cache = new JsonCache<JudgeRun[]>(
      mkdtempSync(join(tmpdir(), "inference-live-")),
    );
    const key = buildCacheKey([
      provider.provider(),
      provider.modelName(),
      "live-cache-test",
    ]);
    const options = {
      provider,
      system: SYSTEM,
      user: "# Assertion\nThe text mentions a dog.\n\n# Text\nThe cat sat on the mat.",
      runs: 1,
      cache,
      cacheKey: key,
    };

    const first = await runEnsemble(options);
    const second = await runEnsemble(options);

    expect(first[0]?.cached).toBe(false);
    expect(second[0]?.cached).toBe(true);
    expect(second[0]?.verdict).toEqual(first[0]?.verdict);

    const pricing = pricingFor(provider.modelName());
    expect(costOfRuns(first, pricing)).toBeGreaterThan(0);
    expect(costOfRuns(second, pricing)).toBe(0);
  }, 60000);
});
