import { describe, expect, it } from "vitest";
import { costOfRuns, costOfUsage, pricingFor } from "../../src/index.js";

describe("pricingFor", () => {
  it("resolves a known model", () => {
    expect(pricingFor("claude-sonnet-4-5")).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
  });

  it("resolves a pinned variant by prefix", () => {
    expect(pricingFor("claude-sonnet-4-5-20250929")).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
  });

  it("knows claude-sonnet-4-6", () => {
    expect(pricingFor("claude-sonnet-4-6")).toBeDefined();
  });

  it("returns undefined for an unknown model rather than guessing", () => {
    expect(pricingFor("some-new-model")).toBeUndefined();
  });

  it("prefers an explicit override", () => {
    expect(
      pricingFor("claude-sonnet-4-5", { inputPerMTok: 1, outputPerMTok: 2 }),
    ).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
  });
});

describe("costOfUsage", () => {
  it("prices tokens per million", () => {
    expect(
      costOfUsage(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { inputPerMTok: 3, outputPerMTok: 15 },
      ),
    ).toBeCloseTo(18);
  });

  it("costs nothing when pricing is unknown", () => {
    expect(
      costOfUsage({ inputTokens: 1_000_000, outputTokens: 0 }, undefined),
    ).toBe(0);
  });

  it("costs nothing when usage is unreported (e.g. the Claude CLI)", () => {
    expect(costOfUsage(undefined, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(
      0,
    );
  });
});

describe("costOfRuns", () => {
  const pricing = { inputPerMTok: 3, outputPerMTok: 15 };

  it("sums uncached runs", () => {
    const runs = [
      { usage: { inputTokens: 1_000_000, outputTokens: 0 }, cached: false },
      { usage: { inputTokens: 1_000_000, outputTokens: 0 }, cached: false },
    ];
    expect(costOfRuns(runs, pricing)).toBeCloseTo(6);
  });

  it("excludes cached runs — a replay makes no call and costs nothing", () => {
    const runs = [
      { usage: { inputTokens: 1_000_000, outputTokens: 0 }, cached: true },
      { usage: { inputTokens: 1_000_000, outputTokens: 0 }, cached: false },
    ];
    expect(costOfRuns(runs, pricing)).toBeCloseTo(3);
  });

  it("excludes runs with no usage", () => {
    expect(costOfRuns([{ cached: false }], pricing)).toBe(0);
  });
});
