// Reading a provider's identity without constructing it — and without a credential.
// Runs with no API key.

import {
  DEFAULT_MODELS,
  DEFAULT_OPENAI_BASE_URL,
  InferenceError,
  makeProvider,
  resolveProviderIdentity,
} from "@hawkeyexl/inference";

// Cache keys and price lookups need the provider's identity. They do not need a client,
// and a fully-cached run should not demand an API key. resolveProviderIdentity constructs
// nothing and reads no credential.
console.log("anthropic default:", resolveProviderIdentity({ provider: "anthropic" }));
console.log("explicit model:  ", resolveProviderIdentity({ provider: "anthropic", model: "claude-haiku-4-5" }));
console.log("openai default:  ", resolveProviderIdentity({ provider: "openai" }));

console.log("per-provider defaults:", DEFAULT_MODELS);
console.log("openai base url:", DEFAULT_OPENAI_BASE_URL);

// Construction is where a credential is required. A missing key is an *operational*
// failure, thrown as InferenceError — not a model failure recorded on a run.
try {
  makeProvider({ provider: "anthropic", apiKeyEnv: "EXAMPLE_KEY_THAT_IS_NOT_SET" });
} catch (error) {
  console.log("construction threw:", error instanceof InferenceError);
  console.log("message:", error.message);
}

// So defer construction until you actually need to call out. A run served
// entirely from cache never touches this thunk.
let cached;
const getProvider = () => (cached ??= makeProvider({ provider: "mock" }));

const identity = resolveProviderIdentity({ provider: "mock" });
console.log("identity without constructing:", identity);
console.log("provider constructed yet:", cached !== undefined);

console.log("now constructing:", getProvider().modelName());
console.log("provider constructed yet:", cached !== undefined);
