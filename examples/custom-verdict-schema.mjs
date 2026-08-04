// Wording a verdict schema for your own domain, and the runtime hole to guard.
// Runs with no API key: MockProvider stands in for a real provider.

import { MockProvider, VERDICT_SCHEMA, judge, runEnsemble } from "@hawkeyexl/inference";

// Start from the canonical schema and change only $id, title, and descriptions.
// Descriptions are prompt surface: they reach the model and steer it.
const traceVerdictSchema = structuredClone(VERDICT_SCHEMA);
traceVerdictSchema["$id"] = "my-tool:trace-verdict:1";
traceVerdictSchema["title"] = "Agent trace adherence verdict";
traceVerdictSchema["properties"]["claim"]["description"] =
  "The instruction the agent session was supposed to follow.";
traceVerdictSchema["properties"]["observed"]["description"] =
  "What the agent actually did, quoted from the trace.";
traceVerdictSchema["properties"]["reasoning"]["description"] =
  "Why the trace does or does not satisfy the instruction.";

console.log("canonical $id:", VERDICT_SCHEMA["$id"]);
console.log("override $id: ", traceVerdictSchema["$id"]);
console.log("structure unchanged:",
  JSON.stringify(Object.keys(traceVerdictSchema["properties"])) ===
  JSON.stringify(Object.keys(VERDICT_SCHEMA["properties"])));

const provider = new MockProvider([
  {
    json: {
      claim: "The agent reads the skill file before acting.",
      observed: "The session opened SKILL.md at step 2.",
      match: "pass",
      confidence: 0.94,
      reasoning: "The read precedes every tool call that depends on it.",
    },
  },
]);

const consensus = await judge({
  provider,
  system: "You evaluate whether an agent session followed its instructions.",
  user: "# Instruction\nRead the skill file first.\n\n# Trace\n...",
  runs: 3,
  schema: traceVerdictSchema, // the override seam
});

console.log("verdict:", consensus.verdict, "zone:", consensus.zone);

// The provider was asked for YOUR schema, not the built-in one.
console.log("schema sent was the override:", provider.requests[0].schema["$id"] === "my-tool:trace-verdict:1");

// The hole: the library validates against whatever schema you give it. It does not
// check that your schema produces JudgeVerdict-shaped objects. Drop a field and you
// get runs that validate and then break the consensus math — at runtime, not compile time.
const missingConfidence = structuredClone(traceVerdictSchema);
delete missingConfidence["properties"]["confidence"];
missingConfidence["required"] = missingConfidence["required"].filter((f) => f !== "confidence");

const badProvider = new MockProvider([
  {
    json: {
      claim: "c",
      observed: "o",
      match: "pass",
      reasoning: "r", // no confidence
    },
  },
]);

const runs = await runEnsemble({
  provider: badProvider,
  system: "s",
  user: "u",
  runs: 1,
  schema: missingConfidence,
});

// It validated happily, because the schema said confidence was not required.
console.log("run validated:", runs[0].error === undefined);
console.log("but confidence is:", runs[0].verdict?.confidence);
console.log("guard this with a round-trip test in your own suite");
