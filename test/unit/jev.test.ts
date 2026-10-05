/**
 * The `jev` provider. The one thing faked is `fetch`, which stands in for
 * TypeSafe's hosted API — a billed network call to a third party. Everything
 * else (request building, response normalization, error mapping, the
 * environment) runs for real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_JEV_BASE_URL,
  DETECTION_ORDER,
  InferenceError,
  JevProvider,
  canDecide,
  makeProvider,
  pricingFor,
  resolveProviderIdentity,
} from "../../src/index.js";
import { toJevRequest } from "../../src/providers/jev.js";
import type { DecideRequest } from "../../src/index.js";

const REQUEST: DecideRequest = {
  state: "The agent ran `git commit --no-verify`.",
  questions: {
    skipped_hook: {
      type: "choice",
      instructions: "Did the agent skip a git hook?",
      criteria: { yes: "A hook was skipped.", no: "No hook was skipped." },
    },
  },
};

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(
  respond: (call: Call) => Response | Promise<Response>,
): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = ((url: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      init,
      body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OK = {
  model: "jev-1.13.0",
  answers: {
    skipped_hook: {
      type: "choice",
      choice: "yes",
      confidence: 0.81,
      probabilities: { yes: 0.81, no: 0.19 },
    },
  },
  usage: { input_tokens: 296, output_tokens: 20 },
};

function provider(
  fetchImpl: typeof fetch,
  over: { baseUrl?: string; timeoutMs?: number } = {},
): JevProvider {
  vi.stubEnv("TYPESAFE_API_KEY", "key-for-tests");
  return new JevProvider("jev-latest", "TYPESAFE_API_KEY", { fetch: fetchImpl, ...over });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("construction", () => {
  it("needs the key in the environment", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(() => new JevProvider("jev-latest", "TYPESAFE_API_KEY")).toThrow(
      new InferenceError("Jev provider needs TYPESAFE_API_KEY set (or choose another provider)"),
    );
  });

  it("names itself, and can decide", async () => {
    const p = provider(fakeFetch(() => json(OK)));
    expect(p.provider()).toBe("jev");
    expect(p.modelName()).toBe("jev-latest");
    expect(canDecide(p)).toBe(true);
    expect(await p.stateLimit()).toBe(32000);
  });

  it("refuses completeJSON, which it cannot answer", async () => {
    const p = provider(fakeFetch(() => json(OK)));
    const error = await p
      .completeJSON({ system: "s", user: "u", schema: {}, temperature: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toContain("answers decisions only");
  });
});

describe("the request mapping", () => {
  it("is one-to-one: criteria stay an object of option id to meaning", () => {
    expect(toJevRequest("jev-latest", REQUEST)).toEqual({
      model: "jev-latest",
      state: "The agent ran `git commit --no-verify`.",
      questions: {
        skipped_hook: {
          type: "choice",
          instructions: "Did the agent skip a git hook?",
          criteria: { yes: "A hook was skipped.", no: "No hook was skipped." },
        },
      },
    });
  });

  it("passes an object or array state through untouched", () => {
    expect(toJevRequest("m", { ...REQUEST, state: { turn: 3 } }).state).toEqual({ turn: 3 });
    expect(toJevRequest("m", { ...REQUEST, state: [1, 2] }).state).toEqual([1, 2]);
  });

  it("posts to /v1/systemone with a bearer key", async () => {
    const f = fakeFetch(() => json(OK));
    await provider(f).decide(REQUEST);
    const [call] = f.calls;
    expect(call?.url).toBe(`${DEFAULT_JEV_BASE_URL}/v1/systemone`);
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer key-for-tests");
    expect(headers["content-type"]).toBe("application/json");
    expect(call?.body).toEqual(toJevRequest("jev-latest", REQUEST));
  });

  it("honours a baseUrl, with or without a trailing slash", async () => {
    const f = fakeFetch(() => json(OK));
    await provider(f, { baseUrl: "https://jev.internal/" }).decide(REQUEST);
    expect(f.calls[0]?.url).toBe("https://jev.internal/v1/systemone");
  });

  it("rejects a question with more options than Jev accepts, before any call", async () => {
    const criteria = Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => [`o${i}`, `option ${i}`]),
    );
    const f = fakeFetch(() => json(OK));
    await expect(
      provider(f).decide({ ...REQUEST, questions: { q: { type: "choice", instructions: "?", criteria } } }),
    ).rejects.toThrow(/at most 255/);
    expect(f.calls).toHaveLength(0);
  });

  it("applies the shared request validation before any call", async () => {
    const f = fakeFetch(() => json(OK));
    await expect(provider(f).decide({ state: "s", questions: {} })).rejects.toThrow(
      "decide() needs at least one question.",
    );
    expect(f.calls).toHaveLength(0);
  });
});

describe("the response", () => {
  it("becomes answers through the shared normalization, plus usage", async () => {
    const res = await provider(fakeFetch(() => json(OK))).decide(REQUEST);
    expect(res.answers["skipped_hook"]).toEqual({
      choice: "yes",
      probabilities: { yes: 0.81 / 1, no: 0.19 / 1 },
      confidence: 0.81,
    });
    expect(res.usage).toEqual({ inputTokens: 296, outputTokens: 20 });
  });

  it("renormalizes probabilities that do not sum to 1", async () => {
    const body = structuredClone(OK);
    body.answers.skipped_hook.probabilities = { yes: 3, no: 1 };
    const res = await provider(fakeFetch(() => json(body))).decide(REQUEST);
    expect(res.answers["skipped_hook"]?.probabilities).toEqual({ yes: 0.75, no: 0.25 });
    expect(res.answers["skipped_hook"]?.confidence).toBe(0.75);
  });

  it("leaves usage absent when Jev reports none", async () => {
    const { usage: _usage, ...rest } = OK;
    const res = await provider(fakeFetch(() => json(rest))).decide(REQUEST);
    expect(res.usage).toBeUndefined();
  });

  it.each([
    ["is not JSON", () => new Response("<html>", { status: 200 })],
    ["has no answers", () => json({ model: "jev-1.13.0" })],
    ["lacks the question's answer", () => json({ answers: {} })],
    [
      "answers with another type",
      () => json({ answers: { skipped_hook: { type: "score", score: 1 } } }),
    ],
    [
      "has no probabilities",
      () => json({ answers: { skipped_hook: { type: "choice", choice: "yes" } } }),
    ],
  ])("is rejected as malformed when it %s", async (_name, respond) => {
    const error = await provider(fakeFetch(respond)).decide(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toContain("Jev returned a response this library cannot read");
  });

  it("rejects probabilities that name an option the question did not have", async () => {
    const body = structuredClone(OK);
    body.answers.skipped_hook.probabilities = { yes: 0.5, maybe: 0.5 } as never;
    await expect(provider(fakeFetch(() => json(body))).decide(REQUEST)).rejects.toThrow(
      /not one of the question's criteria/,
    );
  });
});

describe("failures", () => {
  async function failure(response: Response): Promise<string> {
    const error = await provider(fakeFetch(() => response))
      .decide(REQUEST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    return (error as Error).message;
  }

  it("names the key variable on a 401", async () => {
    const message = await failure(json({ error: "invalid api key" }, 401));
    expect(message).toContain("Jev rejected the API key");
    expect(message).toContain("TYPESAFE_API_KEY");
  });

  it("carries Jev's own explanation on a 422", async () => {
    const message = await failure(json({ error: { message: "criteria must have 2 options" } }, 422));
    expect(message).toContain("Jev rejected the request as invalid");
    expect(message).toContain("criteria must have 2 options");
  });

  it("says a 429 and a 529 are worth retrying", async () => {
    expect(await failure(json({ message: "slow down" }, 429))).toContain("rate limit");
    expect(await failure(json({}, 529))).toContain("overloaded");
  });

  it("reports any other status with its code and body text", async () => {
    const message = await failure(new Response("upstream exploded", { status: 502 }));
    expect(message).toContain("HTTP 502");
    expect(message).toContain("upstream exploded");
  });

  it("wraps a network failure", async () => {
    const f = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const error = await provider(f).decide(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toContain("Jev request failed");
    expect((error as Error).message).toContain("fetch failed");
  });

  it("gives up after timeoutMs", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      })) as unknown as typeof fetch;
    const error = await provider(hang, { timeoutMs: 20 }).decide(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toContain("timed out after 20ms");
  });
});

describe("the factory", () => {
  it("builds a jev provider with its default model and key variable", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "key-for-tests");
    const p = makeProvider({ provider: "jev" });
    expect(p).toBeInstanceOf(JevProvider);
    expect(p.modelName()).toBe("jev-latest");
    expect(resolveProviderIdentity({ provider: "jev" })).toEqual({
      provider: "jev",
      model: "jev-latest",
    });
  });

  it("takes a key variable, baseUrl and timeout from the spec", async () => {
    vi.stubEnv("MY_JEV_KEY", "other-key");
    const f = fakeFetch(() => json(OK));
    const p = makeProvider({
      provider: "jev",
      apiKeyEnv: "MY_JEV_KEY",
      baseUrl: "https://jev.internal",
      jev: { fetch: f },
    });
    if (!canDecide(p)) throw new Error("jev must decide");
    await p.decide(REQUEST);
    expect(f.calls[0]?.url).toBe("https://jev.internal/v1/systemone");
    expect((f.calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer other-key",
    );
  });

  it("is never picked by auto-detection", () => {
    expect(DETECTION_ORDER).not.toContain("jev");
  });

  it("has a price for the pinned model, and none for the moving alias", () => {
    expect(pricingFor("jev-1.13.0")).toEqual({ inputPerMTok: 0.042, outputPerMTok: 0 });
    expect(pricingFor("jev-latest")).toBeUndefined();
  });
});
