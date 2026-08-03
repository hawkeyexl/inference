import { describe, expect, it, afterEach } from "vitest";
import {
  DEFAULT_MODELS,
  InferenceError,
  MockProvider,
  extractJson,
  makeProvider,
  resolveProviderIdentity,
  stripNulls,
  toStrictSchema,
} from "../../src/index.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveProviderIdentity", () => {
  it("resolves identity without constructing the provider or needing a key", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    expect(resolveProviderIdentity({ provider: "anthropic" })).toEqual({
      provider: "anthropic",
      model: DEFAULT_MODELS.anthropic,
    });
  });

  it("honors an explicit model over the default", () => {
    expect(
      resolveProviderIdentity({ provider: "openai", model: "gpt-4o" }),
    ).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("treats a null model as unset", () => {
    expect(
      resolveProviderIdentity({ provider: "claude-cli", model: null }).model,
    ).toBe(DEFAULT_MODELS["claude-cli"]);
  });
});

describe("makeProvider", () => {
  it("constructs each provider and reports its identity", () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["OPENAI_API_KEY"] = "test-key";

    expect(makeProvider({ provider: "anthropic" }).provider()).toBe("anthropic");
    expect(makeProvider({ provider: "openai" }).provider()).toBe("openai");
    expect(makeProvider({ provider: "claude-cli" }).provider()).toBe(
      "claude-cli",
    );
    expect(makeProvider({ provider: "mock" }).provider()).toBe("mock");
  });

  it("fails with an InferenceError when the Anthropic key is missing", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    expect(() => makeProvider({ provider: "anthropic" })).toThrow(
      InferenceError,
    );
    expect(() => makeProvider({ provider: "anthropic" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("honors a custom apiKeyEnv", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["MY_KEY"] = "test-key";
    expect(
      makeProvider({ provider: "anthropic", apiKeyEnv: "MY_KEY" }).provider(),
    ).toBe("anthropic");
  });

  it("allows a keyless OpenAI-compatible server when baseUrl is not OpenAI", () => {
    delete process.env["OPENAI_API_KEY"];
    expect(() =>
      makeProvider({ provider: "openai", baseUrl: "http://localhost:11434/v1" }),
    ).not.toThrow();
  });

  it("still insists on a key for api.openai.com", () => {
    delete process.env["OPENAI_API_KEY"];
    expect(() => makeProvider({ provider: "openai" })).toThrow(InferenceError);
  });

  it("rejects an unknown provider name", () => {
    expect(() =>
      makeProvider({ provider: "gemini" as never }),
    ).toThrow(/Unknown provider/);
  });

  it("passes scripted responses through to the mock provider", async () => {
    const provider = makeProvider({
      provider: "mock",
      mockResponses: [{ json: { ok: true } }],
    });
    const response = await provider.completeJSON({
      system: "s",
      user: "u",
      schema: {},
      temperature: 0,
    });
    expect(response.json).toEqual({ ok: true });
  });
});

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips markdown fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers an object embedded in prose", () => {
    expect(extractJson('Sure! Here you go: {"a":1} Hope that helps.')).toEqual({
      a: 1,
    });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJson("no json here")).toThrow(/no parseable JSON/);
  });
});

describe("toStrictSchema", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      tags: { type: "array", uniqueItems: true, items: { type: "string" } },
      nested: {
        type: "object",
        properties: { inner: { type: "number" } },
      },
    },
    required: ["name"],
  };

  it("lists every property as required", () => {
    const strict = toStrictSchema(schema);
    expect(strict["required"]).toEqual(["name", "tags", "nested"]);
  });

  it("expresses optionality as a null type union", () => {
    const strict = toStrictSchema(schema) as never as {
      properties: Record<string, { type: unknown }>;
    };
    expect(strict.properties["name"]!.type).toEqual(["string", "null"]);
  });

  it("drops keywords outside the strict subset", () => {
    const strict = JSON.stringify(toStrictSchema(schema));
    expect(strict).not.toContain("minLength");
    expect(strict).not.toContain("uniqueItems");
  });

  it("recurses into nested objects", () => {
    const strict = toStrictSchema(schema) as never as {
      properties: { nested: { required: string[] } };
    };
    expect(strict.properties.nested.required).toEqual(["inner"]);
  });

  it("does not mutate the input schema", () => {
    const before = JSON.stringify(schema);
    toStrictSchema(schema);
    expect(JSON.stringify(schema)).toBe(before);
  });

  it("closes every object, not just the root", () => {
    // OpenAI strict mode requires additionalProperties:false on EVERY object.
    // A nested object without it is rejected with a schema error, which
    // permanently downgrades the provider to the json_object fallback.
    const strict = toStrictSchema(schema) as never as {
      additionalProperties: boolean;
      properties: { nested: { additionalProperties: boolean } };
    };
    expect(strict.additionalProperties).toBe(false);
    expect(strict.properties.nested.additionalProperties).toBe(false);
  });
});

describe("stripNulls", () => {
  it("removes null-valued keys (the strict-mode omitted marker)", () => {
    expect(stripNulls({ a: 1, b: null })).toEqual({ a: 1 });
  });

  it("passes non-objects through untouched", () => {
    expect(stripNulls("text")).toBe("text");
    expect(stripNulls([1, null])).toEqual([1, null]);
  });
});

describe("MockProvider", () => {
  it("cycles scripted responses and records requests", async () => {
    const provider = new MockProvider([{ json: { n: 1 } }, { json: { n: 2 } }]);
    const req = { system: "s", user: "u", schema: {}, temperature: 0 };
    expect((await provider.completeJSON(req)).json).toEqual({ n: 1 });
    expect((await provider.completeJSON(req)).json).toEqual({ n: 2 });
    expect((await provider.completeJSON(req)).json).toEqual({ n: 1 });
    expect(provider.requests).toHaveLength(3);
  });

  it("rejects when the script says to error", async () => {
    const provider = new MockProvider([{ error: "boom" }]);
    await expect(
      provider.completeJSON({ system: "", user: "", schema: {}, temperature: 0 }),
    ).rejects.toThrow("boom");
  });

  it("refuses an empty script", () => {
    expect(() => new MockProvider([])).toThrow(/at least one/);
  });
});
