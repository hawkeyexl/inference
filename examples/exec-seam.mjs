// The subprocess seam, used for a command that has nothing to do with inference.
// Runs with no API key and no network — it spawns this same Node binary.

import { makeProvider, realExec } from "@hawkeyexl/inference";

// An argv array, never a shell string. No quoting hazards, no injection surface.
const version = await realExec([process.execPath, "--version"]);
console.log("exit code:", version.code);
console.log("looks like a version:", /^v\d+\./.test(version.stdout.trim()));

// It returns rather than throws. A command that cannot start reports spawnError.
const missing = await realExec(["definitely-not-a-real-command-xyz"]);
console.log("spawn failed without throwing:", missing.spawnError !== undefined);

// A nonzero exit is data, not an exception.
const failed = await realExec([process.execPath, "-e", "process.exit(3)"]);
console.log("nonzero exit reported:", failed.code);

// Input is piped to stdin and the stream closed. This is how the claude-cli provider
// sends prompts: user content routinely exceeds the ~32K Windows argv limit.
const big = "x".repeat(40_000);
const echoed = await realExec(
  [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write(String(d.length)))"],
  { input: big },
);
console.log("bytes received over stdin:", echoed.stdout.trim());

// An env value of undefined UNSETS an inherited variable rather than blanking it.
// Empty string and absent are different things to many programs.
process.env["EXAMPLE_INHERITED"] = "from-parent";
const unset = await realExec(
  [process.execPath, "-e", "console.log('EXAMPLE_INHERITED=' + (process.env.EXAMPLE_INHERITED ?? '<unset>'))"],
  { env: { EXAMPLE_INHERITED: undefined } },
);
console.log(unset.stdout.trim());

// A timeout settles on the timer itself, so a child that ignores SIGTERM
// cannot hang the caller.
const slow = await realExec([process.execPath, "-e", "setTimeout(() => {}, 60000)"], {
  timeoutMs: 300,
});
console.log("timed out cleanly:", slow.timedOut);

// The same type is the test seam. Inject a fake and never spawn in a unit test.
const calls = [];
const fakeExec = async (cmd, opts) => {
  calls.push({ cmd, input: opts?.input });
  return { code: 0, stdout: JSON.stringify({ result: "{}" }), stderr: "", timedOut: false };
};
makeProvider({ provider: "claude-cli", exec: fakeExec });
console.log("ExecFn accepted as a provider seam:", typeof fakeExec === "function");
