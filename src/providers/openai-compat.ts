/**
 * OpenAI-compatible provider: works against OpenAI, Azure, Ollama, Groq,
 * Together, or any server speaking /chat/completions. Prefers strict
 * json_schema response_format; falls back to json_object + schema-in-prompt
 * when the server rejects it (older Ollama, some proxies).
 */
import { InferenceError } from "../types.js";
import type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  InferenceProvider,
} from "./types.js";

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Extract a JSON object from content that may carry markdown fences. */
export function extractJson(content: string): unknown {
  const trimmed = content
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Response contained no parseable JSON object");
  }
}

/**
 * OpenAI strict mode requires `required` to list EVERY property (optionality
 * is expressed as a `null` type union) and rejects keywords outside its
 * subset (minLength, uniqueItems). Transform an all-optional schema into a
 * strict-compatible equivalent; null values are stripped from the response.
 */
export function toStrictSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(schema);
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    delete obj["minLength"];
    delete obj["uniqueItems"];
    const properties = obj["properties"];
    if (properties && typeof properties === "object") {
      obj["required"] = Object.keys(properties);
      for (const prop of Object.values(properties as Record<string, unknown>)) {
        walk(prop);
        if (prop && typeof prop === "object" && !Array.isArray(prop)) {
          const p = prop as Record<string, unknown>;
          if (typeof p["type"] === "string" && p["type"] !== "null") {
            p["type"] = [p["type"], "null"];
          }
        }
      }
    }
    walk(obj["items"]);
  };
  walk(clone);
  return clone;
}

/** Remove null-valued keys (strict-mode "omitted" marker) from a response object. */
export function stripNulls(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== null,
    ),
  );
}

export interface OpenAICompatProviderOptions {
  /** `json_schema.name` sent to the server. Cosmetic; steers some models. */
  schemaName?: string;
}

export class OpenAICompatProvider implements InferenceProvider {
  private supportsJsonSchema = true;
  private readonly schemaName: string;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    apiKeyEnv: string,
    private readonly apiKey: string | undefined = process.env[apiKeyEnv],
    options: OpenAICompatProviderOptions = {},
  ) {
    // Local servers (Ollama) often need no key; only insist for api.openai.com.
    if (!this.apiKey && baseUrl.includes("api.openai.com")) {
      throw new InferenceError(
        `OpenAI provider needs ${apiKeyEnv} set (or point baseUrl at a local server)`,
      );
    }
    this.schemaName = options.schemaName ?? "result";
  }

  provider(): string {
    return "openai";
  }

  modelName(): string {
    return this.model;
  }

  private async chat(body: Record<string, unknown>): Promise<ChatResponse> {
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    const json = (await response.json().catch(() => ({}))) as ChatResponse;
    if (!response.ok) {
      const message = json.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`${message}`);
    }
    return json;
  }

  async completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResponse> {
    const base = {
      model: this.model,
      temperature: req.temperature,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };

    let response: ChatResponse;
    if (this.supportsJsonSchema) {
      try {
        response = await this.chat({
          ...base,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: this.schemaName,
              strict: true,
              schema: toStrictSchema(req.schema),
            },
          },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Fall back on schema/format complaints AND on opaque 400s (gateways
        // that reject response_format without a parseable error body).
        if (
          !/response_format|json_schema|schema/i.test(message) &&
          message !== "HTTP 400"
        ) {
          throw e;
        }
        this.supportsJsonSchema = false;
        response = await this.jsonObjectFallback(base, req);
      }
    } else {
      response = await this.jsonObjectFallback(base, req);
    }

    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty completion response");
    return {
      json: stripNulls(extractJson(content)),
      usage:
        response.usage?.prompt_tokens != null
          ? {
              inputTokens: response.usage.prompt_tokens ?? 0,
              outputTokens: response.usage.completion_tokens ?? 0,
            }
          : undefined,
    };
  }

  private jsonObjectFallback(
    base: Record<string, unknown>,
    req: CompleteJSONRequest,
  ): Promise<ChatResponse> {
    return this.chat({
      ...base,
      messages: [
        {
          role: "system",
          content: `${req.system}\n\nRespond with ONLY a JSON object conforming to this JSON Schema:\n${JSON.stringify(req.schema)}`,
        },
        { role: "user", content: req.user },
      ],
      response_format: { type: "json_object" },
    });
  }
}
