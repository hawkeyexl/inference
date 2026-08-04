// Fail the docs build on a dead internal link — route *or* anchor.
//
// Starlight builds happily with a link to a page that does not exist, which is the
// most common way a CUJ step in docs/content-strategy/journeys/ silently stops
// resolving. This walks the built HTML and asserts that every in-site href resolves
// to a route the build actually generated.
//
// It also validates `#fragment`s. Pages deep-link into each other's headings ~40
// times, and every one of those anchors is derived from hand-chosen heading text —
// rename a heading and the link still "works" in the sense that the page loads, but
// drops the reader at the top with no indication anything is wrong. Nothing else
// catches that.
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

/**
 * route -> the set of element ids on that page.
 *
 * One pass builds both the route set and the anchor index, so the route-derivation
 * rule lives in exactly one place; the key set doubles as the list of valid routes.
 */
const anchors = new Map();
for (const file of files) {
  if (path.basename(file) !== "index.html") continue;
  const rel = path.relative(DIST, path.dirname(file)).split(path.sep).join("/");
  const route = rel === "" ? "/" : `/${rel}/`;
  const html = readFileSync(file, "utf8");
  anchors.set(route, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}
const routes = anchors;

const dead = new Set();
let anchorsChecked = 0;

for (const file of files) {
  const html = readFileSync(file, "utf8");
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const raw = match[1];
    if (!raw.startsWith(`${BASE}/`)) continue; // external, bare anchor, or asset

    const withoutBase = raw.slice(BASE.length);
    const [pathPart, fragment] = withoutBase.replace(/\?.*$/, "").split("#");

    let route = pathPart;
    if (path.extname(route) !== "") continue; // an asset, not a page
    if (!route.endsWith("/")) route += "/";

    if (!routes.has(route)) {
      dead.add(`${path.relative(DIST, file)} -> ${raw}   (no such page)`);
      continue;
    }

    if (fragment === undefined || fragment === "") continue;
    anchorsChecked += 1;
    if (!anchors.get(route)?.has(fragment)) {
      dead.add(`${path.relative(DIST, file)} -> ${raw}   (page exists, #${fragment} does not)`);
    }
  }
}

if (dead.size > 0) {
  console.error(`Dead internal links (${dead.size}):`);
  for (const entry of [...dead].sort()) console.error(`  ${entry}`);
  process.exit(1);
}

console.log(
  `All internal links resolve across ${files.length} pages ` +
    `(${routes.size} routes, ${anchorsChecked} anchor links checked).`,
);
