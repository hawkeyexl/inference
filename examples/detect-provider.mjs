// Letting the library pick a provider this machine can actually use.
// Runs with no API key — detection ends at the free local model.

import {
  DETECTION_ORDER,
  InferenceError,
  detectProvider,
  makeProvider,
} from "@hawkeyexl/inference";

// Priority order, highest first. `mock` is deliberately absent: it answers {} unless
// scripted, which would sail through as a real result.
console.log("detection order:", DETECTION_ORDER);
console.log("mock is never auto-selected:", !DETECTION_ORDER.includes("mock"));

// Detection probes the environment, then the Claude CLI, then the local runtime —
// so it is async. The synchronous factory refuses rather than emitting a
// non-concrete identity that would poison a cache key.
try {
  makeProvider({});
} catch (error) {
  console.log("sync factory refused:", error instanceof InferenceError);
}

// The highest-priority provider this machine can use right now.
const detected = await detectProvider();
console.log("detected:", detected);
console.log("detected is concrete:", DETECTION_ORDER.includes(detected));

// Omitting `provider` in a spec is identical to passing "auto".
// const provider = await makeProviderAsync({});
