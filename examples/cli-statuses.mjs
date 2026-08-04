// Turning a call into a subcommand: per-subject statuses, an exit-code contract,
// a dry run that makes the real run free, and a confidence gate.
//
// Runs with no API key: MockProvider stands in for a real provider.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonCache,
  MockProvider,
  buildCacheKey,
  completeValidatedJSON,
  costOfUsage,
  pricingFor,
  sha256,
} from "@hawkeyexl/inference";

const cacheDir = mkdtempSync(join(tmpdir(), "inference-cli-"));
const PROMPT_VERSION = 1;
const MIN_CONFIDENCE = 0.7;
const MAX_COST_USD = 0.009; // two calls

const schema = {
  type: "object",
  required: ["title", "confidence"],
  properties: {
    title: { type: "string" },
    // Ask the model to score its own answer. A schema-valid answer can still be a bad one.
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
};

const documents = [
  { path: "auth.md", missing: ["title"] },
  { path: "limits.md", missing: ["title"] },
  { path: "webhooks.md", missing: [] }, // nothing to do — must not cost a call
  { path: "errors.md", missing: ["title"] },
  { path: "retries.md", missing: ["title"] },
];

const provider = new MockProvider(
  [
    { json: { title: "Authentication", confidence: 0.94 } },
    { json: { title: "Rate limits", confidence: 0.41 } }, // below the gate
    { json: { title: "Errors", confidence: 0.88 } },
  ],
  "claude-sonnet-4-5",
);

const pricing = pricingFor(provider.modelName());
const cache = new JsonCache(cacheDir, true, "my-tool");

// The dry-run flag is deliberately NOT part of the key. That is what lets the real
// run replay what the dry run already paid for.
const keyFor = (doc) =>
  buildCacheKey([
    provider.provider(),
    provider.modelName(),
    `v${PROMPT_VERSION}`,
    // The existing state belongs in the key: a re-run after a partial fill then asks
    // for what is still missing rather than replaying a proposal already applied.
    sha256([...doc.missing].sort().join(",")),
    sha256(doc.path),
  ]);

async function run({ dryRun }) {
  const statuses = [];
  let spent = 0;
  let calls = 0;
  let replays = 0;

  for (const doc of documents) {
    // Skip before you spend: nothing missing means no call at all.
    if (doc.missing.length === 0) {
      statuses.push([doc.path, "complete"]);
      continue;
    }
    if (pricing !== undefined && spent >= MAX_COST_USD) {
      statuses.push([doc.path, "skipped-budget"]);
      continue;
    }

    const key = keyFor(doc);
    let proposal = cache.get(key);
    if (proposal !== undefined) replays += 1;

    if (proposal === undefined) {
      const result = await completeValidatedJSON({
        provider,
        system: "You propose a title for a documentation page.",
        user: `Path: ${doc.path}\nMissing: ${doc.missing.join(", ")}`,
        schema,
      });
      calls += 1;
      spent += costOfUsage(result.usage, pricing);
      if (result.error !== undefined) {
        statuses.push([doc.path, "error"]);
        continue;
      }
      // Cache BEFORE gating, so re-tuning the threshold costs nothing.
      proposal = result.result;
      cache.set(key, proposal);
    }

    if (proposal.confidence < MIN_CONFIDENCE) {
      statuses.push([doc.path, "low-confidence"]);
      continue;
    }
    // The dry run does everything except write.
    if (!dryRun) applyToDisk(doc, proposal);
    statuses.push([doc.path, "filled"]);
  }

  return { statuses, spent, calls, replays };
}

function applyToDisk() {
  /* the only thing --dry-run skips */
}

const dry = await run({ dryRun: true });
console.log("--- dry run ---");
for (const [path, status] of dry.statuses) console.log(" ", status.padEnd(15), path);
console.log("  calls:", dry.calls, "| replays:", dry.replays, "| spent $" + dry.spent.toFixed(6));

const real = await run({ dryRun: false });
console.log("--- real run ---");
for (const [path, status] of real.statuses) console.log(" ", status.padEnd(15), path);
console.log("  calls:", real.calls, "| replays:", real.replays, "| spent $" + real.spent.toFixed(6));

// Everything the dry run reached is replayed for free. And because replays cost
// nothing, the budget now stretches further — retries.md gets judged this time,
// where the dry run's ceiling had already stopped it.
console.log("  replayed from the dry run:", real.replays);
console.log("  reached further on the re-run:", dry.statuses.at(-1)[1], "->", real.statuses.at(-1)[1]);

// Exit codes: 0 clean, 1 findings, 2 operational. An operational failure would have
// thrown before any of this and is mapped separately.
const hadError = real.statuses.some(([, s]) => s === "error");
const hadFindings = real.statuses.some(([, s]) => s === "low-confidence" || s === "skipped-budget");
console.log("exit code:", hadError ? 1 : hadFindings ? 1 : 0);

rmSync(cacheDir, { recursive: true, force: true });
