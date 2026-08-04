// Fail the docs build on a dead internal link.
//
// Starlight builds happily with a link to a page that does not exist, which is the
// most common way a CUJ step in docs/content-strategy/journeys/ silently stops
// resolving. This walks the built HTML and asserts that every in-site href resolves
// to a route the build actually generated.
//
// Exit 0 = all links resolve, 1 = dead links found, 2 = setup error.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const DIST = path.join("docs", "dist");
const BASE = "/inference";

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    console.error(`Could not read ${dir}. Run \`npm run build\` in docs/ first.`);
    process.exit(2);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

const files = walk(DIST);
if (files.length === 0) {
  console.error(`No HTML found under ${DIST}. Run \`npm run build\` in docs/ first.`);
  process.exit(2);
}

const routes = new Set(
  files
    .filter((f) => path.basename(f) === "index.html")
    .map((f) => {
      const rel = path.relative(DIST, path.dirname(f)).split(path.sep).join("/");
      return rel === "" ? "/" : `/${rel}/`;
    }),
);

const dead = new Set();
for (const file of files) {
  const html = readFileSync(file, "utf8");
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const raw = match[1];
    if (!raw.startsWith(`${BASE}/`)) continue; // external, anchor, or asset

    let route = raw.slice(BASE.length).replace(/[#?].*$/, "");
    if (path.extname(route) !== "") continue; // an asset, not a page
    if (!route.endsWith("/")) route += "/";

    if (!routes.has(route)) {
      dead.add(`${path.relative(DIST, file)} -> ${raw}`);
    }
  }
}

if (dead.size > 0) {
  console.error(`Dead internal links (${dead.size}):`);
  for (const entry of [...dead].sort()) console.error(`  ${entry}`);
  process.exit(1);
}

console.log(`All internal links resolve across ${files.length} pages (${routes.size} routes).`);
