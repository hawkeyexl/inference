import { describe, expect, it } from "vitest";
import {
  MockProvider,
  completeValidatedJSON,
  validatorFor,
} from "../../src/index.js";

const SCHEMA = {
  type: "object",
  required: ["n"],
  properties: { n: { type: "number" } },
  additionalProperties: false,
};

describe("completeValidatedJSON", () => {
  it("returns the validated result and the provider identity", async () => {
    const provider = new MockProvider([{ json: { n: 1 } }]);
    const run = await completeValidatedJSON<{ n: number }>({
      provider,
      system: "s",
      user: "u",
      schema: SCHEMA,
    });
    expect(run.result).toEqual({ n: 1 });
    expect(run.error).toBeUndefined();
    expect(run.provider).toBe("mock");
    expect(run.model).toBe("mock-model");
    expect(run.cached).toBe(false);
    expect(run.usage).toEqual({ inputTokens: 500, outputTokens: 100 });
  });

  it("retries once when the first response fails the schema", async () => {
    const provider = new MockProvider([
      { json: { n: "not a number" } },
      { json: { n: 2 } },
    ]);
    const run = await completeValidatedJSON({
      provider,
      system: "s",
      user: "u",
      schema: SCHEMA,
    });
    expect(run.result).toEqual({ n: 2 });
    expect(provider.requests).toHaveLength(2);
  });

  it("records an error rather than coercing when both attempts fail schema", async () => {
    const provider = new MockProvider([{ json: { wrong: true } }]);
    const run = await completeValidatedJSON({
      provider,
      system: "s",
      user: "u",
      schema: SCHEMA,
    });
    expect(run.result).toBeUndefined();
    expect(run.error).toMatch(/failed schema validation/);
    expect(provider.requests).toHaveLength(2);
  });

  it("retries a thrown API error and records it if it persists", async () => {
    const provider = new MockProvider([{ error: "429 rate limited" }]);
    const run = await completeValidatedJSON({
      provider,
      system: "s",
      user: "u",
      schema: SCHEMA,
    });
    expect(run.result).toBeUndefined();
    expect(run.error).toBe("429 rate limited");
  });

  it("recovers when a transient API error is followed by a good response", async () => {
    const provider = new MockProvider([
      { error: "503" },
      { json: { n: 3 } },
    ]);
    const run = await completeValidatedJSON({
      provider,
      system: "s",
      user: "u",
      schema: SCHEMA,
    });
    expect(run.result).toEqual({ n: 3 });
  });

  it("honors a custom attempt count", async () => {
    const provider = new MockProvider([{ json: { wrong: true } }]);
    await completeValidatedJSON({
      provider,
      system: "s",
      user: "u",
      schema: SCHEMA,
      attempts: 4,
    });
    expect(provider.requests).toHaveLength(4);
  });

  it("passes the temperature through to the provider", async () => {
    const provider = new MockProvider([{ json: { n: 1 } }]);
    await completeValidatedJSON({
      provider,
      system: "s",
      user: "u",
      schema: SCHEMA,
      temperature: 0.7,
    });
    expect(provider.requests[0]?.temperature).toBe(0.7);
  });

  it("defaults temperature to 0", async () => {
    const provider = new MockProvider([{ json: { n: 1 } }]);
    await completeValidatedJSON({
      provider,
      system: "s",
      user: "u",
      schema: SCHEMA,
    });
    expect(provider.requests[0]?.temperature).toBe(0);
  });
});

describe("validatorFor", () => {
  it("reuses the compiled validator for the same schema object", () => {
    const schema = { type: "object" };
    expect(validatorFor(schema)).toBe(validatorFor(schema));
  });

  it("compiles distinct schema objects that share an $id", () => {
    // A caller that rebuilds an equal schema object per call (spreading a base
    // schema to override descriptions, say) misses the identity cache. A
    // shared Ajv registry would reject the second compile as a duplicate $id.
    const build = () => ({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "mytool:verdict:0.1",
      type: "object",
      required: ["n"],
      properties: { n: { type: "number" } },
    });
    expect(() => {
      validatorFor(build());
      validatorFor(build());
    }).not.toThrow();
  });

  it("keeps validators for same-$id schemas independent", () => {
    const a = validatorFor({ $id: "dup:1", type: "object", required: ["a"] });
    const b = validatorFor({ $id: "dup:1", type: "object", required: ["b"] });
    expect(a({ a: 1 })).toBe(true);
    expect(b({ a: 1 })).toBe(false);
  });
});
