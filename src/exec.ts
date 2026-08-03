/**
 * Process execution wrapper for subprocess-backed providers. Uses cross-spawn
 * so npm shims resolve on Windows without `shell: true` and its quoting
 * hazards. Large payloads go through `input` (piped stdin) rather than argv —
 * Windows caps the command line at ~32K characters.
 */
import spawn from "cross-spawn";
import type { ExecFn, ExecResult } from "./providers/types.js";

export const realExec: ExecFn = (cmd, opts = {}) => {
  const [bin, ...args] = cmd;
  if (!bin) {
    return Promise.resolve<ExecResult>({
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnError: "Empty command",
    });
  }
  return new Promise<ExecResult>((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: [opts.input != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeoutMs = opts.timeoutMs ?? 60000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Settle on the timeout itself rather than waiting for 'close'. On POSIX
      // a child that handles SIGTERM survives kill(), so 'close' would never
      // fire and the caller would hang forever with no timeout error. (On
      // Windows kill() is forceful, so this is belt-and-braces there.)
      settle({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    const settle = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    if (opts.input != null && child.stdin) {
      // EPIPE from a child that exits before reading is not our failure.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }

    // setEncoding routes chunks through a StringDecoder, so multi-byte UTF-8
    // characters straddling pipe-chunk boundaries decode correctly; a raw
    // per-chunk Buffer.toString() would corrupt them nondeterministically.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e) =>
      settle({ code: null, stdout, stderr, timedOut, spawnError: e.message }),
    );
    child.on("close", (code) => settle({ code, stdout, stderr, timedOut }));
  });
};
