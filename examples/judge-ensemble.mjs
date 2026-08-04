// An LLM-as-judge ensemble, and proof that an errored run can never pass silently.
// Runs with no API key: MockProvider stands in for a real provider.

import { MockProvider, judge, mockVerdict } from "@hawkeyexl/inference";

const system = "You evaluate whether a page satisfies an assertion.";
const user = "# Assertion\nThe page documents authentication.\n\n# Page\nUse a bearer token.";

// Three confident agreeing runs.
const unanimous = new MockProvider([
  mockVerdict("pass", 0.95),
  mockVerdict("pass", 0.93),
  mockVerdict("pass", 0.97),
]);

const clean = await judge({ provider: unanimous, system, user, runs: 3 });

console.log("verdict:", clean.verdict);
console.log("zone:", clean.zone);
console.log("votes:", clean.votes);
console.log("agreement:", clean.agreement.toFixed(2));
console.log("meanConfidence:", clean.meanConfidence.toFixed(2));

// The same ensemble, with a provider failure scripted in.
//
// Each run retries once before giving up, so a single scripted error would be
// absorbed by the retry and never reach the consensus. Two consecutive errors
// exhaust one run's attempts and produce a genuinely errored run.
const flaky = new MockProvider([
  mockVerdict("pass", 0.95),
  { error: "429 rate limited" },
  { error: "429 rate limited" },
  mockVerdict("pass", 0.97),
]);

const degraded = await judge({ provider: flaky, system, user, runs: 3 });

console.log("degraded.verdict:", degraded.verdict);
console.log("degraded.zone:", degraded.zone);
console.log("degraded.votes:", degraded.votes);

// An errored run counts against consensus. It can push a result toward review;
// it can never produce a silent pass.
console.log("errored run forced review:", degraded.zone === "human-review");
