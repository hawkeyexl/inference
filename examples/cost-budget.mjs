// Pricing a run, and the difference between "costs zero" and "cannot be priced".
// Runs with no API key: MockProvider stands in for a real provider.

import {
  MockProvider,
  costOfRuns,
  mockVerdict,
  pricingFor,
  runEnsemble,
} from "@hawkeyexl/inference";

const system = "You evaluate whether a page satisfies an assertion.";
const user = "# Assertion\nThe page documents authentication.\n\n# Page\nUse a bearer token.";
const verdicts = [mockVerdict("pass", 0.95), mockVerdict("pass", 0.93), mockVerdict("pass", 0.97)];

// A model the built-in table knows.
const priced = new MockProvider(verdicts, "claude-sonnet-4-5");
const pricedRuns = await runEnsemble({ provider: priced, system, user, runs: 3 });
const pricedPricing = pricingFor(priced.modelName());

console.log("known model:", priced.modelName());
console.log("  pricing:", pricedPricing);
console.log("  cost usd:", costOfRuns(pricedRuns, pricedPricing).toFixed(6));

// A pinned variant resolves by longest matching prefix, so it prices correctly.
console.log("pinned variant:", pricingFor("claude-sonnet-4-5-20250929"));

// A model the table does not know. Price is undefined — never a guess.
const unpriced = new MockProvider(verdicts, "some-new-model-v1");
const unpricedRuns = await runEnsemble({ provider: unpriced, system, user, runs: 3 });
const unpricedPricing = pricingFor(unpriced.modelName());

console.log("unknown model:", unpriced.modelName());
console.log("  pricing:", unpricedPricing);
console.log("  cost usd:", costOfRuns(unpricedRuns, unpricedPricing).toFixed(6));

// This is the trap. A budget gate over an unpriced model is not satisfied — it is inert.
const maxCostUsd = 0.5;
const spend = costOfRuns(unpricedRuns, unpricedPricing);
console.log("  budget gate passes:", spend < maxCostUsd, "— but only because the price is unknown");
console.log("  gate is inert:", unpricedPricing === undefined);

// Supply a price you know to make the gate real again.
const override = { inputPerMTok: 2, outputPerMTok: 8 };
const overridden = pricingFor(unpriced.modelName(), override);
console.log("  with override:", costOfRuns(unpricedRuns, overridden).toFixed(6), "usd");
