/**
 * Claude CLI provider: shells out to the `claude` CLI using its local
 * authentication — no API key needed. Token usage is not reported, so cost
 * shows as unknown.
 */
import { realExec } from "../exec.js";
import { extractJson } from "./openai-compat.js";
import type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  ExecFn,
  InferenceProvider,
} from "./types.js";

export class ClaudeCliProvider implements InferenceProvider {
  constructor(
    private readonly model: string,
    private readonly command: string = "claude",
    private readonly exec: ExecFn = realExec,
    private readonly timeoutMs: number = 180000,
  ) {}

  provider(): string {
    return "claude-cli";
  }

  modelName(): string {
    return this.model;
  }

  async completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResponse> {
    const prompt = [
      req.user,
      "",
      "Respond with ONLY a JSON object conforming to this JSON Schema — no",
      "prose, no markdown fences:",
      JSON.stringify(req.schema),
    ].join("\n");

    // The prompt is piped via stdin: user content routinely exceeds the ~32K
    // Windows command-line limit when passed as an argument.
    const result = await this.exec(
      [
        this.command,
        "-p",
        "--append-system-prompt",
        req.system,
        "--output-format",
        "json",
        "--model",
        this.model,
      ],
      { timeoutMs: this.timeoutMs, input: prompt },
    );

    if (result.spawnError) {
      throw new Error(
        `Failed to run ${this.command}: ${result.spawnError} (is the Claude CLI installed?)`,
      );
    }
    if (result.timedOut) throw new Error("Claude CLI timed out");
    if (result.code !== 0) {
      throw new Error(
        `Claude CLI exited ${result.code}: ${result.stderr.trim().slice(-300)}`,
      );
    }

    // --output-format json wraps the answer: { result: "...", ... }
    //
    // When it isn't JSON at all the CLI is talking to a human, not to us — an
    // update banner, a login prompt, a proxy interception page. A bare
    // `SyntaxError: Unexpected token 'W'` would reach the end user of a
    // consuming CLI naming neither the culprit nor the fix, so say who printed
    // it and quote enough for a login prompt to be recognisable on sight.
    // Collapsed to one line and capped, like the stderr tail above, so a
    // megabyte of HTML cannot become the error message.
    let wrapper: { result?: string };
    try {
      wrapper = JSON.parse(result.stdout) as { result?: string };
    } catch {
      const excerpt = result.stdout.trim().replace(/\s+/g, " ").slice(0, 200);
      throw new Error(
        `Claude CLI printed non-JSON output (is it logged in?): ${excerpt || "(no output)"}`,
      );
    }
    if (typeof wrapper.result !== "string") {
      throw new Error("Claude CLI returned no result field");
    }
    return { json: extractJson(wrapper.result) };
  }
}
