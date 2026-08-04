// A cached ensemble: the second run replays from disk, calls nothing, and costs nothing.
// Runs with no API key: MockProvider stands in for a real provider.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonCache,
  MockProvider,
  buildCacheKey,
  costOfRuns,
  mockVerdict,
  pricingFor,
  runEnsemble,
  sha256,
} from "@hawkeyexl/inference";

const cacheDir = mkdtempSync(join(tmpdir(), "inference-example-"));

const provider = new MockProvider(
  [mockVerdict("pass", 0.95), mockVerdict("pass", 0.93), mockVerdict("pass", 0.97)],
  "claude-sonnet-4-5",
);

const system = "You evaluate whether a page satisfies an assertion.";
const pageBody = "# Authentication\nUse a bearer token. Refresh it every 24 hours.";
const user = `# Assertion\nThe page documents authentication.\n\n# Page\n${pageBody}`;
const runs = 3;

// You compose the key, because only you know what should invalidate an entry.
// The library hashes the parts you name; it ships no PROMPT_VERSION of its own.
const MY_PROMPT_VERSION = 4;
const cacheKey = buildCacheKey([
  provider.provider(),
  provider.modelName(),
  `v${MY_PROMPT_VERSION}`,
  `r${runs}`,
  sha256(pageBody), // pre-hash long parts; key parts should stay short
]);

const cache = new JsonCache(cacheDir, true, "my-tool");
const pricing = pricingFor(provider.modelName());

const first = await runEnsemble({ provider, system, user, runs, cache, cacheKey, label: "my-tool" });
const second = await runEnsemble({ provider, system, user, runs, cache, cacheKey, label: "my-tool" });

console.log("first cached flags:", first.map((r) => r.cached));
console.log("second cached flags:", second.map((r) => r.cached));

// The provider saw three requests in total, not six.
console.log("provider calls:", provider.requests.length);

// Verdicts are identical, and the replay is free.
console.log("verdicts match:", JSON.stringify(first.map((r) => r.verdict?.match)) === JSON.stringify(second.map((r) => r.verdict?.match)));
console.log("first cost usd:", costOfRuns(first, pricing).toFixed(6));
console.log("replay cost usd:", costOfRuns(second, pricing).toFixed(6));

rmSync(cacheDir, { recursive: true, force: true });
