// Gating an optional feature on cost, and making every failure land softly.
// Runs with no API key: MockProvider stands in for a real provider.

import {
  InferenceError,
  MockProvider,
  completeValidatedJSON,
  costOfUsage,
  makeProvider,
  pricingFor,
} from "@hawkeyexl/inference";

// Your CLI's own error type. Your fail() handler maps this to an exit code —
// and only this, which is why a foreign error type must never escape.
class MyToolError extends Error {}

// Operational failures are thrown at construction. Translate them at the boundary.
function buildProvider(spec) {
  try {
    return makeProvider(spec);
  } catch (error) {
    if (error instanceof InferenceError) throw new MyToolError(`config: ${error.message}`);
    throw error;
  }
}

try {
  buildProvider({ provider: "anthropic", apiKeyEnv: "EXAMPLE_KEY_THAT_IS_NOT_SET" });
} catch (error) {
  console.log("translated:", error instanceof MyToolError);
  console.log("message:", error.message.slice(0, 46));
}

// A model failure is different: never thrown, always recorded on the run.
const schema = {
  type: "object",
  required: ["title"],
  properties: { title: { type: "string" } },
  additionalProperties: false,
};

const provider = new MockProvider(
  [
    { json: { title: "Authentication" } },
    { json: { title: "Rate limits" } },
    // Two consecutive rejects exhaust one document's attempts, since each call
    // retries once. One would simply be absorbed by the retry.
    { json: { nope: true } },
    { json: { nope: true } },
    { json: { title: "Webhooks" } },
  ],
  "claude-sonnet-4-5",
);

const pricing = pricingFor(provider.modelName());
const maxCostUsd = 0.009;
const documents = ["auth.md", "limits.md", "errors.md", "webhooks.md", "retries.md"];

let spent = 0;
let filled = 0;
let skipped = 0;

for (const doc of documents) {
  // Gate BEFORE the call. Checking afterwards means the overspend already happened.
  // The pricing guard matters: an unpriced model would make this check inert.
  if (pricing !== undefined && spent >= maxCostUsd) {
    console.log(`budget reached at $${spent.toFixed(6)} — skipping ${doc}`);
    skipped += 1;
    continue;
  }

  const run = await completeValidatedJSON({
    provider,
    system: "You propose a title for a documentation page.",
    user: `Path: ${doc}`,
    schema,
  });

  spent += costOfUsage(run.usage, pricing);

  if (run.error !== undefined) {
    // Warn and move on. The deterministic path is untouched.
    console.log(`${doc}: skipped — ${run.error.slice(0, 38)}`);
    skipped += 1;
    continue;
  }
  filled += 1;
}

console.log("filled:", filled, "skipped:", skipped);
console.log("spent usd:", spent.toFixed(6), "ceiling usd:", maxCostUsd.toFixed(6));

// The ceiling is soft in two ways, both worth designing around:
//
//  1. Gating before each call bounds the overshoot to one call. It does not
//     prevent one — the call that crosses the line has already been paid for.
//  2. A retried request reports only the SUCCESSFUL attempt's usage, so the two
//     rejected attempts on errors.md cost real input tokens that never reached
//     this total.
//
// Leave headroom rather than treating the number as exact.
console.log("calls actually made:", provider.requests.length);
console.log("calls charged to the total:", filled);
