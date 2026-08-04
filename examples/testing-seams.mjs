// The three injection seams: test an entire integration with no network,
// no credential, and no GGUF weights.

import {
  MockProvider,
  completeValidatedJSON,
  judge,
  makeProvider,
  makeProviderAsync,
  mockVerdict,
} from "@hawkeyexl/inference";

const system = "You evaluate whether a page satisfies an assertion.";
const user = "# Assertion\nThe page documents authentication.\n\n# Page\nUse a bearer token.";

// ---------------------------------------------------------------------------
// Seam 1 — MockProvider, for anything above the provider contract.
// ---------------------------------------------------------------------------

const provider = new MockProvider([mockVerdict("pass", 0.95)]); // cycles when exhausted
const consensus = await judge({ provider, system, user, runs: 3 });
console.log("1. verdict:", consensus.verdict, "zone:", consensus.zone);

// requests records every CompleteJSONRequest, in order. This is how you assert on
// the part you actually own: that your prompt and schema were composed correctly.
console.log("   requests seen:", provider.requests.length);
console.log("   system prompt matched:", provider.requests[0].system === system);
console.log("   temperature:", provider.requests[0].temperature);

// An { error } entry rejects, which is how you prove your failure paths.
const flaky = new MockProvider([{ error: "429 rate limited" }]);
const failed = await completeValidatedJSON({
  provider: flaky,
  system,
  user,
  schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
});
console.log("   scripted failure recorded:", failed.error);

// ---------------------------------------------------------------------------
// Seam 2 — ExecFn, for the claude-cli provider's subprocess.
// ---------------------------------------------------------------------------

const calls = [];
const fakeExec = async (cmd, opts) => {
  calls.push({ cmd, input: opts?.input });
  // The CLI wraps its answer in a { result: string } envelope.
  return {
    code: 0,
    stdout: JSON.stringify({
      result: JSON.stringify({
        claim: "The page documents authentication.",
        observed: "The page describes bearer tokens.",
        match: "pass",
        confidence: 0.88,
        reasoning: "The token type is stated explicitly.",
      }),
    }),
    stderr: "",
    timedOut: false,
  };
};

const cli = makeProvider({ provider: "claude-cli", exec: fakeExec });
const cliResult = await judge({ provider: cli, system, user, runs: 1 });

console.log("2. verdict:", cliResult.verdict, "zone:", cliResult.zone);
console.log("   argv:", calls[0].cmd.slice(0, 2).join(" "), "...");
// The prompt goes over stdin, never argv — user content routinely exceeds the
// ~32K Windows command-line limit.
console.log("   prompt sent over stdin:", calls[0].input.includes("bearer token"));
console.log("   prompt absent from argv:", !calls[0].cmd.join(" ").includes("bearer token"));

// ---------------------------------------------------------------------------
// Seam 3 — LlamaRuntime, for in-process local inference.
// ---------------------------------------------------------------------------

const fakeRuntime = {
  async getMemoryBudgetBytes() {
    return 16_000_000_000;
  },
  async resolveModelFile(uri, directory) {
    return `${directory}/${uri.split("/").pop()}`;
  },
  async loadModel() {
    return {
      async createSession() {
        return {
          async prompt() {
            return {
              text: JSON.stringify({
                claim: "The page documents authentication.",
                observed: "The page describes bearer tokens.",
                match: "pass",
                confidence: 0.9,
                reasoning: "Stated directly.",
              }),
              usage: { inputTokens: 400, outputTokens: 60 },
              stopReason: "stop",
            };
          },
          async dispose() {},
        };
      },
      async dispose() {},
    };
  },
};

const local = await makeProviderAsync({ provider: "llama-cpp", llamaRuntime: fakeRuntime });
const localResult = await judge({ provider: local, system, user, runs: 1 });

console.log("3. model:", local.modelName());
console.log("   verdict:", localResult.verdict, "zone:", localResult.zone);
console.log("   no weights downloaded, no GPU touched");
