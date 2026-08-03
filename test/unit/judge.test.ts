import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JsonCache,
  MockProvider,
  VERDICT_SCHEMA,
  computeConsensus,
  judge,
  mockVerdict,
  resetTemperatureWarning,
  runEnsemble,
  zoneFor,
  type JudgeRun,
} from "../../src/index.js";

function run(
  match: "pass" | "fail" | "partial" | null,
  confidence = 0.95,
): JudgeRun {
  const base = {
    provider: "mock",
    model: "mock-model",
    cached: false,
    durationMs: 1,
  };
  if (match === null) return { ...base, error: "boom" };
  return {
    ...base,
    verdict: {
      claim: "c",
      observed: "o",
      match,
      confidence,
      reasoning: "r",
    },
  };
}

afterEach(() => {
  resetTemperatureWarning();
  vi.restoreAllMocks();
});

describe("computeConsensus", () => {
  it("counts votes and averages confidence", () => {
    const c = computeConsensus([run("pass", 0.9), run("pass", 0.7)]);
    expect(c.votes).toEqual({ pass: 2, fail: 0, partial: 0, error: 0 });
    expect(c.verdict).toBe("pass");
    expect(c.agreement).toBe(1);
    expect(c.meanConfidence).toBeCloseTo(0.8);
  });

  it("counts partial as fail for the binary verdict but keeps it visible", () => {
    const c = computeConsensus([run("partial"), run("partial")]);
    expect(c.verdict).toBe("fail");
    expect(c.votes.partial).toBe(2);
    expect(c.votes.fail).toBe(0);
  });

  it("does not treat a tie as a pass", () => {
    expect(computeConsensus([run("pass"), run("fail")]).verdict).toBe("fail");
  });

  it("counts an errored run against consensus", () => {
    const c = computeConsensus([run("pass"), run("pass"), run(null)]);
    expect(c.votes.error).toBe(1);
    // Errored runs are excluded from the agreement denominator but block the
    // unanimity that auto-pass requires.
    expect(zoneFor(c)).toBe("human-review");
  });

  it("reports zero agreement when every run errored", () => {
    const c = computeConsensus([run(null), run(null)]);
    expect(c.agreement).toBe(0);
    expect(c.meanConfidence).toBe(0);
  });
});

describe("zoneFor", () => {
  it("auto-passes a unanimous, high-confidence ensemble", () => {
    expect(zoneFor(computeConsensus([run("pass", 0.95), run("pass", 0.9)]))).toBe(
      "auto-pass",
    );
  });

  it("auto-fails a unanimous, high-confidence failure", () => {
    expect(zoneFor(computeConsensus([run("fail", 0.95)]))).toBe("auto-fail");
  });

  it("treats a unanimous partial as an auto-fail", () => {
    expect(zoneFor(computeConsensus([run("partial", 0.95)]))).toBe("auto-fail");
  });

  it("routes a split ensemble to a human", () => {
    expect(zoneFor(computeConsensus([run("pass"), run("fail")]))).toBe(
      "human-review",
    );
  });

  it("routes a unanimous but low-confidence ensemble to a human", () => {
    expect(zoneFor(computeConsensus([run("pass", 0.5)]))).toBe("human-review");
  });

  it("honors custom thresholds", () => {
    const c = computeConsensus([run("pass", 0.6)]);
    expect(zoneFor(c, { autoPass: 0.5, autoFail: 0.5 })).toBe("auto-pass");
  });
});

describe("runEnsemble", () => {
  it("makes one independent request per run", async () => {
    const provider = new MockProvider([mockVerdict("pass", 0.95)]);
    const runs = await runEnsemble({
      provider,
      system: "s",
      user: "u",
      runs: 3,
    });
    expect(runs).toHaveLength(3);
    expect(provider.requests).toHaveLength(3);
    expect(runs.every((r) => r.verdict?.match === "pass")).toBe(true);
  });

  it("defaults to the canonical verdict schema", async () => {
    const provider = new MockProvider([mockVerdict("pass", 0.9)]);
    await runEnsemble({ provider, system: "s", user: "u", runs: 1 });
    expect(provider.requests[0]?.schema).toBe(VERDICT_SCHEMA);
  });

  it("accepts a consumer-supplied schema so domain wording survives", async () => {
    const custom = {
      ...VERDICT_SCHEMA,
      $id: "agentevals:verdict:0.1",
    } as Record<string, unknown>;
    const provider = new MockProvider([mockVerdict("pass", 0.9)]);
    const runs = await runEnsemble({
      provider,
      system: "s",
      user: "u",
      runs: 1,
      schema: custom,
    });
    expect(provider.requests[0]?.schema).toBe(custom);
    expect(runs[0]?.verdict?.match).toBe("pass");
  });

  it("records an errored run instead of dropping it", async () => {
    const provider = new MockProvider([{ error: "429" }]);
    const runs = await runEnsemble({ provider, system: "s", user: "u", runs: 2 });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.verdict === undefined && r.error === "429")).toBe(
      true,
    );
  });

  it("replays a cached ensemble identically without calling the provider", async () => {
    const cache = new JsonCache<JudgeRun[]>(
      mkdtempSync(join(tmpdir(), "inference-judge-")),
    );
    const first = new MockProvider([mockVerdict("pass", 0.95)]);
    const a = await runEnsemble({
      provider: first,
      system: "s",
      user: "u",
      runs: 3,
      cache,
      cacheKey: "k",
    });

    const second = new MockProvider([mockVerdict("fail", 0.1)]);
    const b = await runEnsemble({
      provider: second,
      system: "s",
      user: "u",
      runs: 3,
      cache,
      cacheKey: "k",
    });

    expect(second.requests).toHaveLength(0);
    expect(b.map((r) => r.verdict)).toEqual(a.map((r) => r.verdict));
    expect(b.every((r) => r.cached)).toBe(true);
  });

  it("does not consult the cache without a key", async () => {
    const cache = new JsonCache<JudgeRun[]>(
      mkdtempSync(join(tmpdir(), "inference-judge-")),
    );
    const provider = new MockProvider([mockVerdict("pass", 0.9)]);
    await runEnsemble({ provider, system: "s", user: "u", runs: 1, cache });
    expect(provider.requests).toHaveLength(1);
  });

  it("warns once about a nonzero temperature", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new MockProvider([mockVerdict("pass", 0.9)]);
    const opts = { provider, system: "s", user: "u", runs: 1, temperature: 0.7 };
    await runEnsemble(opts);
    await runEnsemble(opts);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/temperature/);
  });
});

describe("judge", () => {
  it("returns a zoned consensus in one call", async () => {
    const provider = new MockProvider([mockVerdict("pass", 0.95)]);
    const consensus = await judge({
      provider,
      system: "s",
      user: "u",
      runs: 3,
    });
    expect(consensus.verdict).toBe("pass");
    expect(consensus.zone).toBe("auto-pass");
    expect(consensus.runs).toHaveLength(3);
  });

  it("honors custom zone thresholds", async () => {
    const provider = new MockProvider([mockVerdict("pass", 0.6)]);
    const consensus = await judge({
      provider,
      system: "s",
      user: "u",
      runs: 1,
      zones: { autoPass: 0.99, autoFail: 0.99 },
    });
    expect(consensus.zone).toBe("human-review");
  });
});
