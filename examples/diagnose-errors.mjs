// Every failure class, provoked for real, so the messages on the error reference
// cannot drift away from the ones the library actually produces.
//
// Runs with no API key and no network.

import {
  InferenceError,
  MockProvider,
  completeValidatedJSON,
  extractJson,
  judge,
  makeProvider,
  makeProviderAsync,
  mockVerdict,
} from "@hawkeyexl/inference";

// ---------------------------------------------------------------------------
// Class 1 — operational. Thrown as InferenceError, at construction.
// ---------------------------------------------------------------------------

const thrown = (fn) => {
  try {
    fn();
    return "DID NOT THROW";
  } catch (error) {
    return `${error instanceof InferenceError ? "InferenceError" : error.constructor.name}: ${error.message.split("\n")[0]}`;
  }
};

console.log("[operational]");
console.log(" 1.", thrown(() => makeProvider({ provider: "anthropic", apiKeyEnv: "NOT_SET_XYZ" })));
console.log(" 2.", thrown(() => makeProvider({})));
console.log(" 3.", thrown(() => makeProvider({ provider: "llama-cpp", model: "auto" })));
console.log(" 4.", thrown(() => makeProvider({ provider: "nope" })));
console.log(" 5.", thrown(() => makeProvider({ provider: "llama-cpp", model: "not-a-model" })));
console.log(" 6.", thrown(() => new MockProvider([])));

// ---------------------------------------------------------------------------
// Class 2 — model failure. Never thrown; recorded on run.error.
// ---------------------------------------------------------------------------

const schema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
  additionalProperties: false,
};

console.log("\n[model failure — recorded, never thrown]");

// Validation exhausted after both attempts.
const invalid = await completeValidatedJSON({
  provider: new MockProvider([{ json: { wrong: 1 } }]),
  system: "s",
  user: "u",
  schema,
});
console.log(" 7. run.error:", invalid.error.split(";")[0]);
console.log("    run.result:", invalid.result);

// A provider that rejects — here a scripted 429, in production a real one.
const rejected = await completeValidatedJSON({
  provider: new MockProvider([{ error: "429 rate limited" }]),
  system: "s",
  user: "u",
  schema,
});
console.log(" 8. run.error:", rejected.error);

// A response with no JSON in it at all. Shared by openai, claude-cli and llama-cpp.
console.log(" 9.", thrown(() => extractJson("I'm afraid I can't do that.")));

// ---------------------------------------------------------------------------
// The Claude CLI subprocess failures, through an injected exec seam.
// ---------------------------------------------------------------------------

const cliError = async (result) => {
  const provider = makeProvider({ provider: "claude-cli", exec: async () => result });
  const run = await completeValidatedJSON({ provider, system: "s", user: "u", schema });
  return run.error;
};

console.log("\n[claude-cli subprocess]");
console.log("10.", await cliError({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }));
console.log("11.", await cliError({ code: null, stdout: "", stderr: "", timedOut: true }));
console.log("12.", await cliError({ code: 1, stdout: "", stderr: "not logged in", timedOut: false }));
console.log("13.", await cliError({ code: 0, stdout: "{}", stderr: "", timedOut: false }));

// ---------------------------------------------------------------------------
// What a failure does to a verdict — the consequence readers miss.
// ---------------------------------------------------------------------------

const flaky = new MockProvider([
  mockVerdict("pass", 0.95),
  { error: "429 rate limited" },
  { error: "429 rate limited" },
  mockVerdict("pass", 0.97),
]);
const consensus = await judge({ provider: flaky, system: "s", user: "u", runs: 3 });

console.log("\n[what it costs you]");
console.log("14. two runs passed confidently, one errored");
console.log("    votes:", JSON.stringify(consensus.votes));
console.log("    zone:", consensus.zone, "— a rate limit becomes a review queue, not an error");
