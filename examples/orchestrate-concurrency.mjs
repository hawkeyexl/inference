// Running an ensemble across many subjects, and what concurrency does to a budget gate.
// Runs with no API key: MockProvider stands in for a real provider.

import { MockProvider, costOfRuns, mockVerdict, pricingFor, runEnsemble } from "@hawkeyexl/inference";

const subjects = Array.from({ length: 12 }, (_, i) => `page-${String(i + 1).padStart(2, "0")}.md`);
const system = "You evaluate whether a page satisfies an assertion.";

function makeProviderFor() {
  // One provider per worker: MockProvider records requests, and sharing one across
  // workers would interleave them. A real provider is stateless and can be shared.
  return new MockProvider([mockVerdict("pass", 0.95)], "claude-sonnet-4-5");
}

const pricing = pricingFor("claude-sonnet-4-5");

// ---------------------------------------------------------------------------
// A bounded worker pool over a shared index cursor.
//
// Not Promise.all(subjects.map(...)) — that runs all 12 at once. The pool caps
// how many are in flight, and results are assigned BY INDEX so the output keeps
// the input order that a pool would otherwise lose.
// ---------------------------------------------------------------------------

async function runAll({ concurrency, maxCostUsd }) {
  const results = new Array(subjects.length);
  let cursor = 0;
  let spent = 0;
  let skipped = 0;

  const worker = async () => {
    const provider = makeProviderFor();
    while (cursor < subjects.length) {
      const i = cursor++;

      // The gate. Read-then-act on a shared counter: with K workers, up to K
      // subjects can pass this check before any of them adds to `spent`.
      if (pricing !== undefined && spent >= maxCostUsd) {
        results[i] = { subject: subjects[i], status: "skipped-budget" };
        skipped += 1;
        continue;
      }

      const runs = await runEnsemble({
        provider,
        system,
        user: `# Page\n${subjects[i]}`,
        runs: 3,
      });
      spent += costOfRuns(runs, pricing);
      results[i] = { subject: subjects[i], status: "judged" };
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, subjects.length) }, () => worker()),
  );

  return { results, spent, skipped };
}

const ceiling = 0.045; // five ensembles at $0.009 each

const sequential = await runAll({ concurrency: 1, maxCostUsd: ceiling });
const parallel = await runAll({ concurrency: 4, maxCostUsd: ceiling });

console.log("ceiling:      $" + ceiling.toFixed(3));
console.log("sequential:   spent $" + sequential.spent.toFixed(3), "| skipped", sequential.skipped);
console.log("concurrency 4: spent $" + parallel.spent.toFixed(3), "| skipped", parallel.skipped);

// The overshoot is bounded by the number of workers, not by one call.
const overshoot = (parallel.spent - sequential.spent) / 0.009;
console.log("extra ensembles under concurrency:", Math.round(overshoot));

// Order survives the pool, because results are assigned by index.
console.log("order preserved:", parallel.results.every((r, i) => r.subject === subjects[i]));
console.log("first three:", parallel.results.slice(0, 3).map((r) => r.subject).join(" "));
