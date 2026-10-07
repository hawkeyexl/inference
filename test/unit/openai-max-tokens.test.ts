import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat.js";

/** A fetch double: records each body and answers with `content` and `finish`. */
function stubFetch(content: string, finish = "stop") {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200 }),
    );
  });
  return bodies;
}

const req = { system: "s", user: "u", temperature: 0, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } };

describe("OpenAICompatProvider max_tokens", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // A server that reserves credit for the model's whole output window (OpenRouter
  // does) refuses an uncapped request on a small budget, so every request is capped.
  it("caps every request at 4096 output tokens by default", async () => {
    const bodies = stubFetch('{"ok":true}');
    await new OpenAICompatProvider("https://example.test/v1", "m", "K", "key").completeJSON(req);
    expect(bodies[0]?.["max_tokens"]).toBe(4096);
  });

  it("takes the cap from openai.maxTokens", async () => {
    const bodies = stubFetch('{"ok":true}');
    await new OpenAICompatProvider("https://example.test/v1", "m", "K", "key", { maxTokens: 300 }).completeJSON(req);
    expect(bodies[0]?.["max_tokens"]).toBe(300);
  });

  it("names the option when a response stops at the cap", async () => {
    stubFetch('{"ok":', "length");
    await expect(
      new OpenAICompatProvider("https://example.test/v1", "m", "K", "key", { maxTokens: 5 }).completeJSON(req),
    ).rejects.toThrow(/max_tokens \(5\).*openai\.maxTokens/);
  });
});
