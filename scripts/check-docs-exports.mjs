// Fail when an exported symbol is documented on no Reference page.
//
// The package's README once listed 52 export names with no signatures; the Reference
// shelf exists to replace that. This guards the replacement: every value and type
// exported from src/index.ts must appear on at least one page under
// docs/src/content/docs/reference/.
//
// It checks presence, not correctness — a symbol mentioned in passing counts. That is
// deliberate: this is a "did you forget a page" gate, not a prose reviewer.
//
// Requires `npm run build` first (it reads the built barrel).
// Exit 0 = every export is covered, 1 = uncovered exports, 2 = setup error.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REFERENCE_DIR = path.join("docs", "src", "content", "docs", "reference");
const DTS = path.join("dist", "index.d.ts");

let pages;
try {
  pages = readdirSync(REFERENCE_DIR)
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => ({ name, text: readFileSync(path.join(REFERENCE_DIR, name), "utf8") }));
} catch {
  console.error(`Could not read ${REFERENCE_DIR}.`);
  process.exit(2);
}

if (pages.length === 0) {
  console.error(`No .mdx pages found in ${REFERENCE_DIR}.`);
  process.exit(2);
}

let dts;
try {
  dts = readFileSync(DTS, "utf8");
} catch {
  console.error(`Could not read ${DTS}. Run \`npm run build\` first.`);
  process.exit(2);
}

const exportStatement = dts
  .split("\n")
  .filter((line) => line.startsWith("export {"))
  .pop();

if (exportStatement === undefined) {
  console.error(`No export statement found in ${DTS}.`);
  process.exit(2);
}

const symbols = exportStatement
  .replace(/^export \{/, "")
  .replace(/\};?\s*$/, "")
  .split(",")
  .map((entry) => entry.trim().replace(/^type\s+/, ""))
  .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry));

if (symbols.length === 0) {
  console.error(`Parsed no symbols out of the export statement in ${DTS}.`);
  process.exit(2);
}

const uncovered = symbols.filter(
  (symbol) => !pages.some((page) => new RegExp(`\\b${symbol}\\b`).test(page.text)),
);

if (uncovered.length > 0) {
  console.error(`Exports documented on no Reference page (${uncovered.length}):`);
  for (const symbol of uncovered.sort()) console.error(`  ${symbol}`);
  console.error(`\nAdd each to a page under ${REFERENCE_DIR}.`);
  process.exit(1);
}

console.log(`All ${symbols.length} exports appear on a Reference page (${pages.length} pages).`);
