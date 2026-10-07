/**
 * The JSON grammar the local provider generates under: node-llama-cpp's, with
 * every optional space and newline between tokens taken out. ADR 01019.
 *
 * The text checks run against the grammar node-llama-cpp itself generates.
 * The acceptance checks compile it with the real binding on the CPU and ask
 * llama.cpp's grammar engine what it accepts; they are skipped, and reported
 * as skipped, on a machine without the binding.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Llama, LlamaGrammar } from "node-llama-cpp";
import { compactJsonGrammar } from "../../src/providers/llama-worker.js";

// Not exported by the package; the test reads node-llama-cpp's own generator
// so it checks the text the worker really receives.
const { getGbnfGrammarForGbnfJsonSchema } = (await import(
  pathToFileURL(
    resolve("node_modules/node-llama-cpp/dist/utils/gbnfJson/getGbnfGrammarForGbnfJsonSchema.js"),
  ).href
)) as { getGbnfGrammarForGbnfJsonSchema: (schema: unknown) => string };

const VERDICT = {
  type: "object",
  required: ["reasoning", "not-applicable", "followed", "not-followed"],
  additionalProperties: false,
  properties: {
    reasoning: { type: "string", maxLength: 240 },
    "not-applicable": { type: "integer", minimum: 0, maximum: 100 },
    followed: { type: "integer", minimum: 0, maximum: 100 },
    "not-followed": { type: "integer", minimum: 0, maximum: 100 },
  },
};

const NESTED = {
  type: "object",
  required: ["findings", "tags"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim"],
        properties: { claim: { type: "string" }, score: { type: ["number", "null"] } },
      },
    },
    tags: { type: "object", additionalProperties: { type: "string" } },
  },
};

/** The rule bodies, without the root's trailing stop sequence. */
function bodies(gbnf: string): string {
  return gbnf.replace(/"\\n\\n\\n\\n" \[\\n\]\*$/m, "");
}

describe("the compact JSON grammar, as text", () => {
  it.each([
    ["a flat verdict", VERDICT],
    ["nested arrays and maps", NESTED],
  ])("leaves no optional space or newline between tokens in %s", (_, schema) => {
    const full = getGbnfGrammarForGbnfJsonSchema(schema);
    // The grammar as node-llama-cpp builds it allows both, so the check can tell.
    expect(full).toContain("[ ]?");
    expect(bodies(full)).toMatch(/\[\\n\]/);
    const compact = compactJsonGrammar(full);
    expect(compact).not.toContain("[ ]?");
    expect(bodies(compact)).not.toMatch(/\[\\n\]/);
    expect(compact).not.toMatch(/\| *\)?$/m);
  });

  it("keeps the root's stop sequence, so a prompt still ends", () => {
    expect(compactJsonGrammar(getGbnfGrammarForGbnfJsonSchema(VERDICT))).toMatch(
      /"\\n\\n\\n\\n" \[\\n\]\*$/m,
    );
  });

  it("keeps a string property's maxLength", () => {
    expect(compactJsonGrammar(getGbnfGrammarForGbnfJsonSchema(VERDICT))).toMatch(
      /string-char-rule \)\{0,240\}/,
    );
  });

  it("leaves spaces inside quoted text alone", () => {
    const schema = { type: "object", properties: { "a [ ]? b": { const: "x [ ]? y" } } };
    const compact = compactJsonGrammar(getGbnfGrammarForGbnfJsonSchema(schema));
    expect(compact).toContain("a [ ]? b");
    expect(compact).toContain("x [ ]? y");
  });
});

/** Loaded once at module scope so `it.skipIf` can use it at collection time. */
const llama: Llama | undefined = await import("node-llama-cpp")
  .then((m) => m.getLlama({ gpu: false, build: "never" }))
  .catch(() => undefined);
const itWithLlama = it.skipIf(llama === undefined);

/**
 * Whether llama.cpp's grammar engine accepts `text` as a complete output.
 * `_testText` is node-llama-cpp's own check, marked internal; a release that
 * drops it fails here loudly rather than passing.
 */
function accepts(grammar: LlamaGrammar, text: string): boolean {
  return (grammar as unknown as { _testText(text: string): boolean })._testText(
    `${text}\n\n\n\n`,
  );
}

async function compiled(schema: unknown): Promise<{ full: LlamaGrammar; compact: LlamaGrammar }> {
  const full = await llama!.createGrammarForJsonSchema(schema as never);
  const compact = await llama!.createGrammar({ grammar: compactJsonGrammar(full.grammar) });
  return { full, compact };
}

describe("the compact JSON grammar, in llama.cpp", () => {
  const value = { reasoning: "It ran every hook.", "not-applicable": 0, followed: 95, "not-followed": 5 };

  itWithLlama("accepts compact JSON, and rejects the spaces and newlines node-llama-cpp allows", async () => {
    const { full, compact } = await compiled(VERDICT);
    const spaced = JSON.stringify(value).replaceAll('":', '": ').replaceAll(',"', ', "');
    const pretty = JSON.stringify(value, null, 4);
    expect(accepts(full, spaced)).toBe(true);
    expect(accepts(full, pretty)).toBe(true);
    expect(accepts(compact, JSON.stringify(value))).toBe(true);
    expect(accepts(compact, spaced)).toBe(false);
    expect(accepts(compact, pretty)).toBe(false);
  });

  itWithLlama("caps a string at its maxLength", async () => {
    const { compact } = await compiled(VERDICT);
    expect(accepts(compact, JSON.stringify({ ...value, reasoning: "x".repeat(240) }))).toBe(true);
    expect(accepts(compact, JSON.stringify({ ...value, reasoning: "x".repeat(241) }))).toBe(false);
  });

  itWithLlama("accepts nested arrays and maps written compactly", async () => {
    const { compact } = await compiled(NESTED);
    const nested = { findings: [{ claim: "a b", score: 0.5 }, { claim: "c", score: null }], tags: { k: "v w" } };
    expect(accepts(compact, JSON.stringify(nested))).toBe(true);
    expect(accepts(compact, JSON.stringify(nested, null, 2))).toBe(false);
  });
});
