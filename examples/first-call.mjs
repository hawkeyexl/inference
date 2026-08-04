// One schema-constrained call, and the failure branch beside it.
// Runs with no API key: MockProvider stands in for a real provider.

import { MockProvider, completeValidatedJSON } from "@hawkeyexl/inference";

const schema = {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
  additionalProperties: false,
};

// A provider scripted to return a valid response.
const ok = new MockProvider([{ json: { summary: "Covers authentication and token refresh." } }]);

const run = await completeValidatedJSON({
  provider: ok,
  system: "You summarize documentation pages.",
  user: "# Authentication\nUse a bearer token. Refresh it every 24 hours.",
  schema,
});

console.log("result:", run.result);
console.log("usage:", run.usage);
console.log("identity:", run.provider, run.model, "cached:", run.cached);

// A provider scripted to return something the schema rejects, every time.
// completeValidatedJSON tries twice by default, then gives up honestly.
const bad = new MockProvider([{ json: { oops: true } }]);

const failed = await completeValidatedJSON({
  provider: bad,
  system: "You summarize documentation pages.",
  user: "# Authentication\nUse a bearer token.",
  schema,
});

// No throw, and no invented result. The error is recorded on the run.
console.log("failed.result:", failed.result);
console.log("failed.error:", failed.error);
