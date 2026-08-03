/**
 * Anthropic provider: structured output via a single forced tool call whose
 * input schema is the caller's schema — the model cannot answer any other way.
 */
import Anthropic from "@anthropic-ai/sdk";
import { InferenceError } from "../types.js";
import type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  InferenceProvider,
} from "./types.js";

const DEFAULT_TOOL_NAME = "record_result";

export interface AnthropicProviderOptions {
  /**
   * Name of the forced tool. Purely cosmetic to the model, but a descriptive
   * name ("record_verdict", "record_proposal") measurably steers output, so
   * consumers may set their own.
   */
  toolName?: string;
  /** Tool description shown to the model. */
  toolDescription?: string;
  maxTokens?: number;
}

export class AnthropicProvider implements InferenceProvider {
  private readonly client: Anthropic;
  private readonly toolName: string;
  private readonly toolDescription: string;
  private readonly maxTokens: number;

  constructor(
    private readonly model: string,
    apiKeyEnv: string,
    options: AnthropicProviderOptions = {},
  ) {
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new InferenceError(
        `Anthropic provider needs ${apiKeyEnv} set (or choose another provider)`,
      );
    }
    this.client = new Anthropic({ apiKey });
    this.toolName = options.toolName ?? DEFAULT_TOOL_NAME;
    this.toolDescription =
      options.toolDescription ?? "Record the structured result.";
    this.maxTokens = options.maxTokens ?? 1024;
  }

  provider(): string {
    return "anthropic";
  }

  modelName(): string {
    return this.model;
  }

  async completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      tools: [
        {
          name: this.toolName,
          description: this.toolDescription,
          input_schema: req.schema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: this.toolName },
    });

    // A truncated tool call still arrives as a tool_use block, just with
    // partial input. Without this check it fails schema validation instead,
    // burning the retry and reporting a misleading validation error rather
    // than the actionable "raise maxTokens".
    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `Anthropic response hit max_tokens (${this.maxTokens}) before completing the tool call — raise the anthropic.maxTokens option.`,
      );
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("Anthropic response contained no tool_use block");
    }
    return {
      json: toolUse.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
