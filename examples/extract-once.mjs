// Single-shot structured extraction: a narrow request schema, a wider validation schema.
// Runs with no API key: MockProvider stands in for a real provider.

import { MockProvider, completeValidatedJSON, validatorFor } from "@hawkeyexl/inference";

// Every field this tool knows how to fill.
const ALL_FIELDS = { title: { type: "string" }, type: { type: "string" }, owner: { type: "string" } };

// The wider schema the response is *validated* against — compiled once, at module scope.
const validateProposal = validatorFor({
  type: "object",
  properties: ALL_FIELDS,
  additionalProperties: false,
});

// The narrower schema the model is *asked* for, built per document.
//
// validatorFor caches on schema object identity, so a builder that returns a fresh
// object every call would recompile Ajv once per document. Memoize on the field set.
const schemaCache = new Map();
function proposalSchema(missing) {
  const key = [...missing].sort().join(",");
  let schema = schemaCache.get(key);
  if (schema === undefined) {
    schema = {
      type: "object",
      required: [...missing].sort(),
      properties: Object.fromEntries([...missing].sort().map((f) => [f, ALL_FIELDS[f]])),
      additionalProperties: false,
    };
    schemaCache.set(key, schema);
  }
  return schema;
}

const provider = new MockProvider([
  { json: { title: "Authentication", type: "how-to" } },
  { json: { title: "Rate limits", type: "reference" } },
]);

const documents = [
  { path: "auth.md", missing: ["title", "type"] },
  { path: "limits.md", missing: ["title", "type"] },
];

for (const doc of documents) {
  const run = await completeValidatedJSON({
    provider,
    system: "You propose frontmatter values for a documentation page.",
    user: `Propose values for: ${doc.missing.join(", ")}\n\nPath: ${doc.path}`,
    schema: proposalSchema(doc.missing), // narrow: only what is missing
    validate: validateProposal, // wide: every field this tool accepts
  });

  if (run.error !== undefined) {
    // Never a throw, never a coerced value. Skip the document and keep going.
    console.log(`${doc.path}: skipped — ${run.error}`);
    continue;
  }
  console.log(`${doc.path}:`, run.result);
}

// Two documents, one distinct field set, one compiled request schema.
console.log("distinct schemas built:", schemaCache.size);
console.log("provider calls:", provider.requests.length);
