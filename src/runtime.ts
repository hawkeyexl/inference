/**
 * The one thing this library says about the runtime it was loaded into.
 *
 * `engines.node` is `>=24`, but npm treats an `engines` mismatch as an
 * `EBADENGINE` **warning**, not a refusal — scrolled past in CI, invisible in a
 * transitive install. So an older Node installs cleanly, runs, and then fails
 * somewhere unrelated with an error that never mentions the Node version.
 *
 * This is a warning rather than a throw on purpose. Nothing in `src/` uses a
 * Node-24-only API — the imports are `node:crypto`, `node:fs`, `node:os` and
 * `node:path`, the newest globals are `fetch` (18+) and `structuredClone`
 * (17+), and `tsconfig` targets ES2022 — and the strictest dependency floor is
 * `node-llama-cpp` at `>=20`. Node 24 is this package's *support* policy, not a
 * technical impossibility, and a library has no business refusing to run on a
 * consumer's behalf when it can still do the work. It says so once and
 * continues, the same way the four existing warn-once paths do.
 */

/**
 * The major version `engines.node` declares. `test/unit/runtime.test.ts` pins
 * this against `package.json`, so the two cannot drift apart.
 */
export const MINIMUM_NODE_MAJOR = 24;

let warnedNodeVersion = false;

/**
 * Warn once if the running Node is older than the declared minimum.
 *
 * The version is a parameter so this is testable in-process — no subprocess on
 * a second Node install just to see the string.
 */
export function warnIfUnsupportedNode(
  version: string = process.versions.node,
): void {
  if (warnedNodeVersion) return;
  const major = Number.parseInt(version, 10);
  // An unreadable version is not evidence of an old one. Same rule as an
  // unknown model price: never guess.
  if (!Number.isInteger(major) || major >= MINIMUM_NODE_MAJOR) return;
  warnedNodeVersion = true;
  console.warn(
    `inference: running on Node ${version}, older than the Node ` +
      `${MINIMUM_NODE_MAJOR} this package requires. npm only warns about that ` +
      `at install time (EBADENGINE), so nothing has stopped you yet — upgrade ` +
      `Node, or expect failures this library cannot explain.`,
  );
}

/** Test seam: reset the once-per-process Node version warning. */
export function resetNodeVersionWarning(): void {
  warnedNodeVersion = false;
}
