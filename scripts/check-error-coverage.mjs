// Fail when an error the library can throw is missing from the error reference.
//
// docs/src/content/docs/reference/errors.mdx is a hand-written list of messages, which
// makes it a drift magnet: reword a `throw` in src/ and the page silently documents a
// string nobody will ever see. That is worse than no reference, because a reader who
// pastes their real message finds nothing and concludes the docs are stale everywhere.
//
// The check is deliberately loose about interpolation. A message like
//
//     `Unknown provider "${name}". Available: ${list}.`
//
// is matched on its longest literal run — here `". Available: "` is short, but
// `Unknown provider "` is distinctive enough. We require the longest literal segment
// of every throw to appear somewhere on the page.
//
// Exit 0 = every error documented, 1 = gaps, 2 = setup error.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = "src";
const REFERENCE = path.join("docs", "src", "content", "docs", "reference", "errors.mdx");

/**
 * Shortest literal run we will accept as a fingerprint. Messages are assembled from
 * concatenated template literals, so a single message yields several short runs; we
 * need one distinctive enough to be unlikely by chance but short enough to survive
 * the line breaks the source wraps at.
 */
const MIN_FINGERPRINT = 16;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

let reference;
try {
  reference = readFileSync(REFERENCE, "utf8").replace(/\r\n/g, "\n");
} catch {
  console.error(`Could not read ${REFERENCE}.`);
  process.exit(2);
}

let files;
try {
  files = walk(SRC);
} catch {
  console.error(`Could not read ${SRC}.`);
  process.exit(2);
}

// `throw new InferenceError(` / `throw new Error(` followed by a template or quoted
// string, possibly concatenated across lines. Grab everything up to the closing paren.
const THROW = /throw new (?:Inference)?Error\(\s*([\s\S]*?)\);/g;

/**
 * Pull the literal segments out of a source-level string expression: the parts of
 * template literals outside `${}`, plus whole quoted strings.
 */
function literalRuns(expression) {
  const runs = [];
  const templates = [...expression.matchAll(/`((?:[^`\\]|\\.)*)`/g)];

  if (templates.length > 0) {
    // Template literals only. Quoted strings *inside* a template are interpolation
    // internals like `"${String(spec.provider)}"` — not message text.
    for (const template of templates) {
      for (const literal of template[1].split(/\$\{[^}]*\}/)) runs.push(literal);
    }
  } else {
    for (const quoted of expression.matchAll(/"((?:[^"\\]|\\.)*)"/g)) runs.push(quoted[1]);
  }

  return runs
    .map((run) => run.replace(/\\n/g, " ").replace(/\\`/g, "`").replace(/\s+/g, " ").trim())
    .filter((run) => run.length > 0);
}

const normalisedReference = reference.replace(/\s+/g, " ");
const missing = [];
let checked = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(THROW)) {
    const candidates = literalRuns(match[1]).filter((run) => run.length >= MIN_FINGERPRINT);
    if (candidates.length === 0) continue;

    // The page may quote a message with an interpolation elided (`"<M>"`) or wrapped
    // differently from the source. Requiring the *whole* message would force the page
    // to reproduce line breaks; requiring *any* distinctive fragment is enough to prove
    // the error is documented, and an undocumented one matches none of its fragments.
    checked += 1;
    const found = candidates.some((run) => normalisedReference.includes(run));
    if (!found) {
      const line = text.slice(0, match.index).split("\n").length;
      const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a));
      missing.push(`${file}:${line}\n      "${longest}"`);
    }
  }
}

if (checked === 0) {
  console.error("Parsed no throw sites out of src/ — the matcher is probably broken.");
  process.exit(2);
}

if (missing.length > 0) {
  console.error(`Errors missing from ${REFERENCE} (${missing.length} of ${checked}):`);
  for (const entry of missing) console.error(`  ${entry}`);
  console.error(`\nAdd each message to the error reference, or reword both together.`);
  process.exit(1);
}

console.log(`All ${checked} throw sites are documented in the error reference.`);
