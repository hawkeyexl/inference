/**
 * Installing the optional `node-llama-cpp` peer on demand.
 *
 * Detection ends at `llama-cpp` precisely because it needs no key and no
 * account — but that rung is only reachable if the native binding is present,
 * and npm does not install optional peers. Without this module a machine with
 * no credentials and no binding falls off the end of the chain, which is the
 * one case auto-detection exists to serve.
 *
 * The install goes into a directory this library OWNS — never the consumer's
 * `node_modules`, `package.json` or lockfile. That is the same reasoning ADR
 * 01003 applied to weights: owning a directory removes the hazard instead of
 * defending against it. A consumer's dependency manifest is theirs, and a
 * library that edits it has broken reproducible installs for everyone
 * downstream.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { InferenceError } from "../types.js";
import { realExec } from "../exec.js";
import type { ExecFn } from "./types.js";

/** Pinned to the peer range: below 3.19.0 nothing in the catalog loads. */
const PACKAGE_SPEC = "node-llama-cpp@^3.19.0";

/**
 * The shim doubles as the readiness marker — it is written only after npm
 * exits 0, so its presence means "this prefix is complete".
 */
const SHIM = "loader.mjs";
const LOCK = ".install.lock";

/**
 * Generous by necessity. Prebuilt binaries cover win32-x64, darwin-arm64 and
 * linux-x64; anything else falls back to a CMake build that genuinely takes
 * minutes. `realExec` defaults to 60s, which would kill it half-built.
 */
const INSTALL_TIMEOUT_MS = 900_000;

/** How long to wait for another process's install before giving up. */
const LOCK_WAIT_MS = INSTALL_TIMEOUT_MS;
/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = INSTALL_TIMEOUT_MS + 60_000;

export interface RuntimeInstallOptions {
  /** Defaults to this library's own runtime directory. */
  directory?: string;
  /** Injected for tests; defaults to the real process runner. */
  exec?: ExecFn;
  /** Injected for tests; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Test seam: how the shim is imported once it exists. */
  importShim?: (url: string) => Promise<unknown>;
  /**
   * Test seam: how the consumer's own copy is looked for.
   *
   * Whether an optional peer is installed is a property of the machine, and the
   * behaviour that matters most here — that probing installs nothing — is
   * unobservable on a machine that already has it. Injecting the lookup is the
   * only way to assert it deterministically.
   */
  probeImport?: () => Promise<unknown>;
}

/**
 * Where this library installs the binding — its OWN directory, beside the
 * models directory and for the same reason.
 *
 * `INFERENCE_RUNTIME_DIR` overrides it, mirroring `INFERENCE_MODELS_DIR`.
 */
export function defaultLlamaRuntimeDirectory(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env["INFERENCE_RUNTIME_DIR"] ||
    join(homedir(), ".hawkeyexl-inference", "runtime")
  );
}

/**
 * The URL that imports the binding from the library-owned prefix. The
 * local-model worker is a separate process, so it imports by URL what this
 * process imported through `importNodeLlamaCpp`.
 */
export function nodeLlamaCppShimUrl(
  directory: string = defaultLlamaRuntimeDirectory(),
): string {
  return pathToFileURL(join(directory, SHIM)).href;
}

/**
 * Is this import failure "the package is not here", as opposed to "the package
 * is here and broken"?
 *
 * The distinction decides whether installing can possibly help. `ERR_MODULE_NOT_FOUND`
 * is what Node raises for a missing bare specifier; `MODULE_NOT_FOUND` is its
 * CJS spelling. Anything else — a failed `dlopen`, an unsupported Node, a
 * package whose `exports` do not match — means the package resolved and then
 * failed, and no amount of reinstalling changes that.
 */
export function isModuleNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether the binding can be used, and at what cost, WITHOUT installing it. */
export type RuntimeStatus =
  /** Importable right now — either the consumer's own copy or a filled prefix. */
  | { state: "present" }
  /** Absent, but an install is permitted. Using it will fetch a native module. */
  | { state: "installable"; directory: string }
  /** Absent and installing is refused, so this provider cannot be used. */
  | { state: "refused"; reason: string };

/**
 * Can the local runtime be used, and would using it install anything?
 *
 * Detection needs this rather than simply calling `getMemoryBudgetBytes`:
 * that goes through `importNodeLlamaCpp` and would install, which turns
 * `availableProviders()` — a function whose entire job is to REPORT what is
 * usable — into one that changes what is usable. Probing must not have the side
 * effect it is probing for.
 */
export async function nodeLlamaCppStatus(
  options: RuntimeInstallOptions = {},
): Promise<RuntimeStatus> {
  const env = options.env ?? process.env;
  const directory = options.directory ?? defaultLlamaRuntimeDirectory(env);

  const probeImport =
    options.probeImport ?? ((): Promise<unknown> => import("node-llama-cpp"));
  try {
    await probeImport();
    return { state: "present" };
  } catch (e) {
    // Only a genuine "no such package" means absent. An ABI mismatch, a missing
    // system library, or an unsupported Node all fail here too, and installing
    // over them would fetch the same broken package again while burying the
    // real cause under a download.
    if (!isModuleNotFound(e)) {
      return {
        state: "refused",
        reason: `node-llama-cpp is installed but failed to load (${describe(e)})`,
      };
    }
    // Genuinely absent — fall through to our own prefix.
  }
  if (existsSync(join(directory, SHIM))) return { state: "present" };

  if ((env["INFERENCE_NO_AUTO_INSTALL"] ?? "") !== "") {
    return {
      state: "refused",
      reason: `node-llama-cpp is not installed and INFERENCE_NO_AUTO_INSTALL is set`,
    };
  }
  return { state: "installable", directory };
}

/**
 * In-flight installs, keyed by directory. docmeta and the ensemble runner both
 * work several items at once, so without this every worker that misses the
 * binding would spawn its own npm against one prefix.
 */
const installs = new Map<string, Promise<unknown>>();

let warnedInstall = false;

/** Test seam: forget in-flight installs and re-arm the one-time warning. */
export function resetRuntimeInstall(): void {
  installs.clear();
  warnedInstall = false;
}

/**
 * Import `node-llama-cpp` from the library-owned prefix, installing it first if
 * it is not there.
 *
 * Callers reach this only after a plain `import("node-llama-cpp")` has already
 * failed — a consumer who installed the peer themselves never gets here.
 */
export function importNodeLlamaCpp(
  options: RuntimeInstallOptions = {},
): Promise<unknown> {
  const env = options.env ?? process.env;
  const directory = options.directory ?? defaultLlamaRuntimeDirectory(env);

  const existing = installs.get(directory);
  if (existing) return existing;

  const pending = fromPrefix(directory, env, options);
  // Drop a failed attempt so the next call retries: a download killed by a
  // flaky network must not poison the runtime for the rest of the process —
  // the same rule `load()` applies to weights.
  const guarded = pending.catch((e: unknown) => {
    if (installs.get(directory) === guarded) installs.delete(directory);
    throw e;
  });
  installs.set(directory, guarded);
  return guarded;
}

async function fromPrefix(
  directory: string,
  env: Record<string, string | undefined>,
  options: RuntimeInstallOptions,
): Promise<unknown> {
  const importShim =
    options.importShim ?? ((url: string): Promise<unknown> => import(url));
  const shim = join(directory, SHIM);

  if (existsSync(shim)) return importShim(pathToFileURL(shim).href);

  if ((env["INFERENCE_NO_AUTO_INSTALL"] ?? "") !== "") {
    throw new InferenceError(
      `The llama-cpp provider needs node-llama-cpp, and INFERENCE_NO_AUTO_INSTALL ` +
        `is set. Install it yourself (npm i ${PACKAGE_SPEC}), unset ` +
        `INFERENCE_NO_AUTO_INSTALL to allow installing into ${directory}, or name ` +
        `a different provider.`,
    );
  }

  mkdirSync(directory, { recursive: true });
  await withLock(directory, async () => {
    // Another process may have finished while we waited for the lock.
    if (existsSync(shim)) return;
    warnInstalling(directory);
    await runInstall(directory, env, options);
    // Only now is the prefix complete, so only now does it get its marker.
    writeFileSync(shim, `export * from "node-llama-cpp";\n`, "utf8");
  });

  return importShim(pathToFileURL(shim).href);
}

async function runInstall(
  directory: string,
  env: Record<string, string | undefined>,
  options: RuntimeInstallOptions,
): Promise<void> {
  // Anchor npm to this directory. Without a manifest here npm walks UP looking
  // for one, and would install into whatever project happens to be above us —
  // the exact mutation this module exists to avoid.
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      `${JSON.stringify(
        {
          name: "hawkeyexl-inference-runtime",
          version: "0.0.0",
          private: true,
          description:
            "Auto-installed runtime for @hawkeyexl/inference. Safe to delete.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  const exec = options.exec ?? realExec;
  const result = await exec(
    [
      "npm",
      "install",
      "--prefix",
      directory,
      PACKAGE_SPEC,
      "--no-audit",
      "--no-fund",
    ],
    { timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS, env },
  );

  if (result.spawnError != null) {
    throw new InferenceError(
      `Could not run npm to install node-llama-cpp (${result.spawnError}). ` +
        `Install it yourself with: npm i ${PACKAGE_SPEC}, or name a provider ` +
        `that does not need it.`,
    );
  }
  if (result.timedOut) {
    throw new InferenceError(
      `Installing node-llama-cpp into ${directory} timed out. A source build ` +
        `can take a while — retry, raise the timeout, or install it yourself ` +
        `with: npm i ${PACKAGE_SPEC}.`,
    );
  }
  if (result.code !== 0) {
    throw new InferenceError(
      `Installing node-llama-cpp into ${directory} failed (exit ${String(
        result.code,
      )}).\n${tail(result.stderr || result.stdout)}\n` +
        `Install it yourself with: npm i ${PACKAGE_SPEC}, or name a provider ` +
        `that does not need it.`,
    );
  }
}

/** Enough npm output to diagnose the failure, not enough to bury the advice. */
function tail(output: string, lines = 12): string {
  return output.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

/**
 * Pulling a native module is not free, and the weights that follow are far less
 * free. Say so before it starts, not after a build has already stalled on it.
 */
function warnInstalling(directory: string): void {
  if (warnedInstall) return;
  warnedInstall = true;
  console.warn(
    `inference: node-llama-cpp is not installed — fetching it into ${directory} ` +
      `so the local model can run. This is a one-time native install; set ` +
      `INFERENCE_NO_AUTO_INSTALL=1 to refuse it, or name a provider that does ` +
      `not need it.`,
  );
}

/** What `withDirLock` needs to know about the work it guards. */
export interface DirLockOptions {
  /** The lock file's name, inside the directory. */
  name: string;
  /** Finishes a wait early: whoever held the lock has already done the work. */
  isDone: () => boolean;
  /** For the timeout message, after "to": `install node-llama-cpp`. */
  what: string;
  /** How long to wait for another holder before giving up. */
  waitMs: number;
  /** A lock older than this belonged to a process that died holding it. */
  staleMs: number;
}

/**
 * Cross-process guard around one directory's worth of work: the runtime
 * prefix's install, or one model's download.
 *
 * The in-process memo covers a worker pool inside one run; this covers two runs
 * started at once, where two npm processes writing one `node_modules` is how a
 * prefix ends up half-written. The lock file holds its owner's pid.
 *
 * When the lock is held and `isDone()` turns true, the wait ends without
 * running `fn`: the other holder finished the job.
 */
export async function withDirLock(
  directory: string,
  fn: () => Promise<void>,
  options: DirLockOptions,
): Promise<void> {
  const lock = join(directory, options.name);
  const deadline = Date.now() + options.waitMs;

  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (isStaleLock(lock, options.staleMs)) {
        // Whoever held this died. Reclaiming a stale lock is safer than
        // blocking forever on a process that will never return.
        // ponytail: two waiters can both reclaim, and one then removes the
        // other's fresh lock. A rename-based reclaim if that ever shows up.
        rmSync(lock, { force: true });
        continue;
      }
      if (options.isDone()) return;
      if (Date.now() > deadline) {
        throw new InferenceError(
          `Timed out waiting for another process to ${options.what} into ` +
            `${directory}. If nothing else is running, remove ${lock} and retry.`,
        );
      }
      await delay(250);
    }
  }

  try {
    await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Is the lock held by a live process, and not yet stale? */
export function lockIsHeld(
  directory: string,
  name: string,
  staleMs: number,
): boolean {
  const lock = join(directory, name);
  return existsSync(lock) && !isStaleLock(lock, staleMs);
}

/** Past `staleMs`, or written by a process that is no longer running. */
function isStaleLock(lock: string, staleMs: number): boolean {
  if (ageOf(lock) > staleMs) return true;
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
  } catch {
    return false;
  }
  // An empty lock is one whose owner has not written its pid yet.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else, so it is alive.
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The runtime prefix's install, serialised across processes. */
function withLock(directory: string, fn: () => Promise<void>): Promise<void> {
  return withDirLock(directory, fn, {
    name: LOCK,
    isDone: () => existsSync(join(directory, SHIM)),
    what: "install node-llama-cpp",
    waitMs: LOCK_WAIT_MS,
    staleMs: LOCK_STALE_MS,
  });
}

/** Infinity for a lock that vanished mid-check, so the caller retries. */
function ageOf(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
