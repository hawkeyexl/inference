// Fail when the content strategy stops describing the site it documents.
//
// docs/content-strategy/ is only useful if its cross-references hold. This enforces the
// three invariants stated in docs/content-strategy/README.md:
//
//   1. No danglers  — every aud-*/persona-*/cuj-* reference resolves to a defined `id:`.
//   2. No orphans   — every persona names >=1 CUJ, and every CUJ names >=1 persona.
//   3. Live routes  — every CUJ step's `doc:` route maps to a real page file, and a step
//                     marked `exists: true` is not pointing at a page that is only a stub.
//
// Invariant 3 is the one nothing else catches: journey files name routes that are never
// links in built HTML, so check-docs-links.mjs cannot see them. Renaming a page would
// otherwise silently orphan the journeys that route through it.
//
// Exit 0 = all invariants hold, 1 = violations, 2 = setup error.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const STRATEGY_DIR = path.join("docs", "content-strategy");
const PAGES_DIR = path.join("docs", "src", "content", "docs");

const ID_PATTERN = /\b(?:aud|persona|cuj)-[a-z0-9-]+/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(STRATEGY_DIR);
} catch {
  console.error(`Could not read ${STRATEGY_DIR}.`);
  process.exit(2);
}

/**
 * A route like `/judge/caching/` maps to docs/src/content/docs/judge/caching.mdx.
 *
 * Both extensions are accepted: most pages are `.mdx` because they import components,
 * but a page with no components (the 404) is plain `.md`, and Starlight serves both.
 */
const EXTENSIONS = [".mdx", ".md"];
function pageFileFor(route) {
  const clean = route.replace(/^\/+|\/+$/g, "");
  const candidates =
    clean === ""
      ? EXTENSIONS.map((ext) => path.join(PAGES_DIR, `index${ext}`))
      : EXTENSIONS.flatMap((ext) => [
          path.join(PAGES_DIR, `${clean}${ext}`),
          path.join(PAGES_DIR, clean, `index${ext}`),
        ]);
  return candidates.find((candidate) => existsSync(candidate));
}

const defined = new Set();
const documents = [];
const problems = [];

/**
 * Only audience, persona, and CUJ files declare an `id:`. Index files (`_overview.md`),
 * the directory README, and the information_architecture specs are prose by design.
 */
const ENTITY_DIRS = new Set(["audiences", "personas", "journeys"]);
function isEntityFile(file) {
  const name = path.basename(file);
  if (name.startsWith("_") || name === "README.md") return false;
  return ENTITY_DIRS.has(path.basename(path.dirname(file)));
}

for (const file of files) {
  // Normalise line endings before parsing. A CRLF file would otherwise fail the
  // frontmatter match silently, and every id it defines would look undefined —
  // reporting danglers everywhere except the real problem.
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);

  if (frontmatter === null) {
    if (isEntityFile(file)) problems.push(`${file}: no YAML frontmatter found`);
    continue;
  }

  const body = frontmatter[1];
  const id = /^id:\s*(\S+)/m.exec(body)?.[1];
  if (id === undefined) {
    problems.push(`${file}: frontmatter defines no id:`);
    continue;
  }
  defined.add(id);
  documents.push({ file, body, id });
}

for (const { file, body, id } of documents) {
  // 1. Danglers.
  for (const reference of new Set(body.match(ID_PATTERN) ?? [])) {
    if (reference !== id && !defined.has(reference)) {
      problems.push(`${file}: references undefined id "${reference}"`);
    }
  }

  // 2. Orphans.
  if (id.startsWith("persona-")) {
    const journeys = /journeys:\n([\s\S]*?)(?=\n\S|$)/.exec(body)?.[1] ?? "";
    if ((journeys.match(/\bcuj-[a-z0-9-]+/g) ?? []).length === 0) {
      problems.push(`${file}: persona "${id}" names no CUJ`);
    }
  }

  if (!id.startsWith("cuj-")) continue;

  const personas = /personas:\n([\s\S]*?)(?=\n\S|$)/.exec(body)?.[1] ?? "";
  if ((personas.match(/\bpersona-[a-z0-9-]+/g) ?? []).length === 0) {
    problems.push(`${file}: CUJ "${id}" names no persona`);
  }

  // 3. Live routes. `entry_point` plus every step's `doc:`.
  //
  // `entry_point` carries no `exists:` of its own, so it is only required to resolve.
  // Only a step that explicitly claims `exists: true` is held to the stronger
  // "the page is not still a Planned stub" rule.
  const routes = [];
  const entryPoint = /^entry_point:\s*(\S+)/m.exec(body)?.[1];
  if (entryPoint !== undefined) {
    routes.push({ route: entryPoint, exists: "unstated", label: "entry_point" });
  }

  for (const step of body.matchAll(/doc:\s*(\S+)\s*\n\s*exists:\s*(\S+)/g)) {
    routes.push({ route: step[1], exists: step[2], label: `step doc: ${step[1]}` });
  }

  for (const { route, exists, label } of routes) {
    const page = pageFileFor(route);
    if (page === undefined) {
      problems.push(`${file}: ${label} -> no page file for route "${route}"`);
      continue;
    }
    // A step claiming full coverage must not point at a page still badged "Planned".
    if (exists === "true" && /^\s*text:\s*Planned\s*$/m.test(readFileSync(page, "utf8"))) {
      problems.push(`${file}: ${label} is \`exists: true\` but ${page} is still a Planned stub`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Content-strategy problems (${problems.length}):`);
  for (const problem of problems.sort()) console.error(`  ${problem}`);
  process.exit(1);
}

const personas = [...defined].filter((id) => id.startsWith("persona-")).length;
const cujs = [...defined].filter((id) => id.startsWith("cuj-")).length;
const audiences = [...defined].filter((id) => id.startsWith("aud-")).length;
console.log(
  `Content strategy intact: ${audiences} audiences, ${personas} personas, ${cujs} CUJs, all routes live.`,
);
