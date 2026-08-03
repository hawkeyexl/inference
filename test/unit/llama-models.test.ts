import { describe, expect, it } from "vitest";
import {
  InferenceError,
  LLAMA_MODELS,
  LLAMA_SELECTORS,
  isLlamaSelector,
  resolveLlamaModelRef,
  tierForBudget,
} from "../../src/index.js";

describe("LLAMA_MODELS catalog", () => {
  it("pins every entry to an exact blob path, never a quant tag", () => {
    for (const [alias, entry] of Object.entries(LLAMA_MODELS)) {
      expect(entry.uri, alias).toMatch(/^hf:[^:]+\/[^:]+\/[^:]+\.gguf$/);
      // A `:QUANT` tag would fail to resolve against the QAT repos, which
      // ship only UD-Q4_K_XL / UD-Q2_K_XL.
      expect(entry.uri.split("/").pop(), alias).toMatch(/\.gguf$/);
    }
  });

  it("never points at a vision projector or multi-token-prediction blob", () => {
    for (const [alias, entry] of Object.entries(LLAMA_MODELS)) {
      expect(entry.uri, alias).not.toContain("mmproj");
      expect(entry.uri, alias).not.toContain("mtp-");
    }
  });

  it("freezes each entry, not just the outer record", () => {
    // A shallow freeze would let a consumer re-point `sizeBytes` and silently
    // change tier selection process-wide, or rewrite a pinned `uri`.
    const entry = LLAMA_MODELS["gemma-4-12b"]!;
    expect(Object.isFrozen(LLAMA_MODELS)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { sizeBytes: number }).sizeBytes = 1;
    }).toThrow(TypeError);
    expect(entry.sizeBytes).toBeGreaterThan(1e9);
    expect(tierForBudget(1e9)).toBe("fast");
  });

  it("records a size and a license for every entry", () => {
    for (const [alias, entry] of Object.entries(LLAMA_MODELS)) {
      expect(entry.sizeBytes, alias).toBeGreaterThan(0);
      expect(entry.license, alias).toBe("Apache-2.0");
    }
  });

  it("has an entry for each concrete tier", () => {
    expect(LLAMA_MODELS["gemma-4-e2b"]?.tier).toBe("fast");
    expect(LLAMA_MODELS["gemma-4-e4b"]?.tier).toBe("balanced");
    expect(LLAMA_MODELS["gemma-4-12b"]?.tier).toBe("quality");
  });
});

describe("isLlamaSelector", () => {
  it("recognises the selector keywords", () => {
    for (const selector of LLAMA_SELECTORS) {
      expect(isLlamaSelector(selector)).toBe(true);
    }
  });

  it("rejects aliases, URIs and paths", () => {
    expect(isLlamaSelector("gemma-4-e4b")).toBe(false);
    expect(isLlamaSelector("hf:unsloth/x-GGUF/x.gguf")).toBe(false);
    expect(isLlamaSelector("./models/x.gguf")).toBe(false);
  });
});

describe("resolveLlamaModelRef", () => {
  it("expands a curated alias to its pinned URI", () => {
    expect(resolveLlamaModelRef("gemma-4-e4b")).toBe(
      LLAMA_MODELS["gemma-4-e4b"]!.uri,
    );
  });

  it("passes a hugging face URI through untouched", () => {
    const uri = "hf:someone/Custom-GGUF/custom-Q4_K_M.gguf";
    expect(resolveLlamaModelRef(uri)).toBe(uri);
  });

  it("passes a local file path through untouched", () => {
    expect(resolveLlamaModelRef("./models/local.gguf")).toBe(
      "./models/local.gguf",
    );
    expect(resolveLlamaModelRef("C:\\models\\local.gguf")).toBe(
      "C:\\models\\local.gguf",
    );
  });

  it("refuses a selector — those need the async hardware probe", () => {
    expect(() => resolveLlamaModelRef("auto")).toThrow(InferenceError);
    expect(() => resolveLlamaModelRef("auto")).toThrow(
      /resolveProviderIdentityAsync/,
    );
  });

  it("rejects an unknown bare name that is neither alias nor URI nor path", () => {
    expect(() => resolveLlamaModelRef("gemma-9-nonexistent")).toThrow(
      InferenceError,
    );
    expect(() => resolveLlamaModelRef("gemma-9-nonexistent")).toThrow(
      /gemma-4-e4b/,
    );
  });
});

describe("tierForBudget", () => {
  it("picks quality on a workstation", () => {
    expect(tierForBudget(32 * 1e9)).toBe("quality");
  });

  it("picks balanced on a mid-range machine", () => {
    expect(tierForBudget(16 * 1e9)).toBe("balanced");
  });

  it("picks fast on a small machine", () => {
    expect(tierForBudget(8 * 1e9)).toBe("fast");
  });

  it("never returns nothing, even on an absurdly small budget", () => {
    expect(tierForBudget(0)).toBe("fast");
  });

  it("is monotonic — more memory never selects a smaller model", () => {
    const order = { fast: 0, balanced: 1, quality: 2 };
    let previous = -1;
    for (let gb = 1; gb <= 64; gb++) {
      const rank = order[tierForBudget(gb * 1e9)];
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });
});
