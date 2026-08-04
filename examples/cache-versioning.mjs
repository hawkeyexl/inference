// Surviving an upgrade: version your cache key, and re-validate on read.
// Runs with no API key: MockProvider stands in for a real provider.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonCache,
  MockProvider,
  buildCacheKey,
  mockVerdict,
  runEnsemble,
} from "@hawkeyexl/inference";

const directory = mkdtempSync(join(tmpdir(), "inference-upgrade-"));

const provider = new MockProvider([mockVerdict("pass", 0.95)], "claude-sonnet-4-5");
const system = "You evaluate whether a page satisfies an assertion.";
const user = "# Assertion\nThe page documents authentication.\n\n# Page\nUse a bearer token.";

// The library composes nothing on your behalf, so a version marker you control is
// the only thing that can invalidate an entry when YOUR prompt or expectations change.
const keyFor = (promptVersion) =>
  buildCacheKey([provider.provider(), provider.modelName(), `v${promptVersion}`, "r1"]);

const cache = new JsonCache(directory, true, "my-tool");

await runEnsemble({ provider, system, user, runs: 1, cache, cacheKey: keyFor(1) });
const replay = await runEnsemble({ provider, system, user, runs: 1, cache, cacheKey: keyFor(1) });
console.log("same version replays:", replay[0].cached);

// Bump the marker when your prompt changes and the old entry is simply not found.
const afterBump = await runEnsemble({ provider, system, user, runs: 1, cache, cacheKey: keyFor(2) });
console.log("bumped version misses:", afterBump[0].cached === false);

// The library cannot know your value shape, so a well-formed but OBSOLETE entry
// replays happily. Re-validate on read — this is the wrapper every consumer writes.
class VerdictCache extends JsonCache {
  get(key) {
    const entry = super.get(key);
    if (!Array.isArray(entry)) return undefined;
    const shapedCorrectly = entry.every(
      (run) => run.error !== undefined || typeof run.verdict?.confidence === "number",
    );
    return shapedCorrectly ? entry : undefined;
  }
}

// Simulate an entry written before `confidence` existed.
const guarded = new VerdictCache(directory, true, "my-tool");
const staleKey = keyFor(3);
guarded.set(staleKey, [
  { verdict: { claim: "c", observed: "o", match: "pass", reasoning: "r" }, provider: "anthropic", model: "m", cached: false, durationMs: 1 },
]);

console.log("raw cache would replay it:", new JsonCache(directory, true, "my-tool").get(staleKey) !== undefined);
console.log("guarded cache rejects it: ", guarded.get(staleKey) === undefined);

rmSync(directory, { recursive: true, force: true });
