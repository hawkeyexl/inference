// Running the llama-cpp provider, and why a selector needs the async factory.
//
// Runs with no API key, no GPU, and no GGUF weights: LlamaRuntime is the injection
// seam the library uses in its own tests. In real use you omit `llamaRuntime`
// entirely and the default runtime downloads and loads real weights.

import {
  InferenceError,
  judge,
  makeProvider,
  makeProviderAsync,
  resolveProviderIdentityAsync,
} from "@hawkeyexl/inference";

// A stand-in for node-llama-cpp. Reports a 16 GB budget and answers with a fixed verdict.
const fakeRuntime = {
  async getMemoryBudgetBytes() {
    return 16 * 1024 ** 3;
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
                observed: "The page describes bearer tokens and refresh.",
                match: "pass",
                confidence: 0.91,
                reasoning: "Both the token type and the refresh interval are stated.",
              }),
              usage: { inputTokens: 420, outputTokens: 78 },
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

// The synchronous factory refuses an unresolved selector rather than recording the
// literal "auto" as cache-key material — which would let a 2.6 GB and a 6.7 GB model
// share cached results, and make one key mean different things on two machines.
try {
  makeProvider({ provider: "llama-cpp", model: "auto", llamaRuntime: fakeRuntime });
} catch (error) {
  console.log("sync factory refused:", error instanceof InferenceError);
  console.log("message:", error.message);
}

// The async forms resolve the selector by measuring the machine, and return the
// concrete model. They delegate to the sync forms for every other provider.
const identity = await resolveProviderIdentityAsync({
  provider: "llama-cpp",
  model: "auto",
  llamaRuntime: fakeRuntime,
});
console.log("auto resolved to:", identity);

const provider = await makeProviderAsync({
  provider: "llama-cpp",
  model: "auto",
  llamaRuntime: fakeRuntime,
});

// The provider satisfies the same contract, so judge and completion code is unchanged.
const consensus = await judge({
  provider,
  system: "You evaluate whether a page satisfies an assertion.",
  user: "# Assertion\nThe page documents authentication.\n\n# Page\nUse a bearer token.",
  runs: 3,
});

console.log("model:", provider.modelName());
console.log("verdict:", consensus.verdict, "zone:", consensus.zone);
console.log("usage reported:", consensus.runs[0].usage);
