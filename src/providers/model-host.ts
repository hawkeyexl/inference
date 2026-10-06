/**
 * The client side of the model host: one long-lived process that keeps local
 * models loaded for the short-lived processes that call them. ADR 01017.
 *
 * A consumer that runs from hooks starts a fresh process per hook. Without a
 * host, each one pays a full model load, and hooks that run together each load
 * their own copy of the weights. With one, the first call starts a detached
 * host (`llama-hostd.ts`) and every later call, from any process, sends its
 * request there over a named pipe or a Unix socket.
 *
 * The wire is newline-delimited JSON: `{ id, op, ... }` in, and
 * `{ id, ok: true, value }` or `{ id, ok: false, error: { name, message } }`
 * out. A connection opens with `hello` and the token the host wrote to a file
 * only this user can read; anything else is closed.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InferenceError } from "../types.js";
import { defaultLlamaModelsDirectory } from "./llama-models.js";
import { defaultLlamaRuntimeDirectory } from "./llama-install.js";
import type { DecideRequest } from "./decide.js";
import type { LlamaGpu } from "./llama-host.js";
import type { CompleteJSONRequest, SharedJSONRequest } from "./types.js";

/**
 * Where a `llama-cpp` provider runs its calls. `"off"`: in this process's own
 * worker. `"connect"`: in a running host, else as `"off"`. `"spawn"`: in a
 * host, starting one when none runs.
 */
export type ModelHostMode = "off" | "connect" | "spawn";

/** How long the host keeps a model loaded after its last call, by default. */
export const DEFAULT_KEEP_ALIVE_MS = 600_000;

/**
 * A call waited in the host's queue for longer than its `hostWaitMs` without
 * starting, and was withdrawn. Nothing ran. Match it by class or by `name`.
 */
export class ModelHostBusyError extends InferenceError {
  constructor(message: string) {
    super(message);
    this.name = "ModelHostBusyError";
  }
}

// --- where the host lives ----------------------------------------------

export interface ModelHostPaths {
  /** Holds the token, the start lock and the log; 0700 where that means anything. */
  dir: string;
  /** A named pipe on Windows, a Unix socket elsewhere. */
  socket: string;
  token: string;
  log: string;
}

/** The start lock's name inside `dir`. */
export const HOST_LOCK = "host.lock";

/**
 * Inside the runtime directory, so `INFERENCE_RUNTIME_DIR` moves the host with
 * the runtime, and a test's temporary directory gets a host of its own.
 */
export function modelHostPaths(
  env: Record<string, string | undefined> = process.env,
): ModelHostPaths {
  const dir = join(defaultLlamaRuntimeDirectory(env), "host");
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hawkeyexl-inference-${userName()}-${createHash("sha256")
          .update(dir)
          .digest("hex")
          .slice(0, 12)}`
      : join(dir, "host.sock");
  return { dir, socket, token: join(dir, "host.token"), log: join(dir, "host.log") };
}

function userName(): string {
  try {
    return userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_") || "user";
  } catch {
    return "user";
  }
}

export function ensureHostDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not ours to change; the token file's own mode still protects it.
  }
}

// --- the wire ------------------------------------------------------------

/** What the host needs to build the provider a call runs on. */
export interface HostedModel {
  model: string;
  modelsDirectory: string;
  gpu?: LlamaGpu;
  contextSize?: number;
  thoughtTokens?: number;
  maxTokens?: number;
}

/** What every queued call carries besides its model. */
export interface HostedCall {
  keepAliveMs: number;
  session?: string;
  waitMs?: number;
}

export type HostFrame =
  | { op: "hello"; token: string }
  | ({ op: "completeJSON"; model: HostedModel; request: CompleteJSONRequest } & HostedCall)
  | ({ op: "decide"; model: HostedModel; request: DecideRequest } & HostedCall)
  | ({ op: "completeJSONShared"; model: HostedModel; request: SharedJSONRequest } & HostedCall)
  | ({ op: "stateLimit"; model: HostedModel } & HostedCall)
  | ({ op: "lease"; model: HostedModel; session: string } & HostedCall)
  | { op: "release"; session: string }
  | { op: "status" }
  | { op: "shutdown" };

export type HostReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };

/** The host went away before it answered. Never escapes this module. */
class HostGone extends Error {}

function rebuildError(error: { name: string; message: string }): Error {
  if (error.name === "ModelHostBusyError") return new ModelHostBusyError(error.message);
  if (error.name === "InferenceError") return new InferenceError(error.message);
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

class HostConnection {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void }
  >();
  /** Settles when the host closes this connection, as it does when it stops. */
  readonly closed: Promise<void>;

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    // `close` follows every error, and settles everything pending.
    socket.on("error", () => undefined);
    this.closed = new Promise((resolve) => {
      socket.once("close", () => {
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const p of pending) p.reject(new HostGone());
        resolve();
      });
    });
  }

  request<T>(frame: HostFrame): Promise<T> {
    if (this.socket.destroyed) return Promise.reject(new HostGone());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.write(`${JSON.stringify({ ...frame, id })}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    const lines = (this.buffer + chunk).split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let reply: HostReply;
      try {
        reply = JSON.parse(line) as HostReply;
      } catch {
        continue;
      }
      const pending = this.pending.get(reply.id);
      if (!pending) continue;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(rebuildError(reply.error));
    }
  }
}

/** A socket to the host, or undefined when nothing is listening there. */
function openSocket(path: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    // ENOENT, ECONNREFUSED, a stale file where the socket was: no host.
    socket.once("error", () => resolve(undefined));
  });
}

/**
 * A connection the host has accepted, or undefined when no host is there to
 * accept it — including one that is stopping, which closes the connection.
 */
async function connectHost(paths: ModelHostPaths): Promise<HostConnection | undefined> {
  const socket = await openSocket(paths.socket);
  if (!socket) return undefined;
  const connection = new HostConnection(socket);
  let token: string;
  try {
    token = readFileSync(paths.token, "utf8").trim();
  } catch {
    connection.close();
    return undefined;
  }
  try {
    await connection.request({ op: "hello", token });
    return connection;
  } catch (e) {
    connection.close();
    if (e instanceof HostGone) return undefined;
    throw e;
  }
}

// --- starting a host -----------------------------------------------------

/** A slow runner boots Node, imports the host and listens well inside this. */
const HOST_START_MS = 60_000;
const HOST_POLL_MS = 100;
/** How long `releaseModelHost({ all: true })` waits for the host to exit. */
const HOST_EXIT_MS = 30_000;

let entryOverride: { path: string; execArgv: string[] } | undefined;

/**
 * The host beside this module: `llama-hostd.js` once built into `dist/`.
 * Absent when a consumer bundled this library into a file of its own.
 */
function hostEntry(): { path: string; execArgv: string[] } | undefined {
  if (entryOverride) return entryOverride;
  const path = fileURLToPath(new URL("./llama-hostd.js", import.meta.url));
  return existsSync(path) ? { path, execArgv: [] } : undefined;
}

/** Test seam: start this file as the host, with these Node flags. */
export function setModelHostEntry(entry: { path: string; execArgv: string[] } | undefined): void {
  entryOverride = entry;
}

let warnedNoEntry = false;

function launch(entry: { path: string; execArgv: string[] }, paths: ModelHostPaths): ChildProcess {
  ensureHostDir(paths.dir);
  const log = openSync(paths.log, "w");
  try {
    const child = spawn(process.execPath, [...entry.execArgv, entry.path], {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

/**
 * Start a host and connect to it. Several clients may start one at once; the
 * start lock lets one win, and the rest exit, so each client relaunches only
 * once its own launch has exited and still nothing answers — as when the
 * winner was a host that was stopping.
 */
async function startHost(paths: ModelHostPaths): Promise<HostConnection | undefined> {
  const entry = hostEntry();
  if (!entry) {
    if (!warnedNoEntry) {
      warnedNoEntry = true;
      console.warn(
        `inference: the model host (llama-hostd.js) is missing beside this library — ` +
          `was it bundled? Running the local model in this process's own worker instead.`,
      );
    }
    return undefined;
  }
  const deadline = Date.now() + HOST_START_MS;
  for (;;) {
    let exited = false;
    const child = launch(entry, paths);
    child.once("exit", () => (exited = true));
    child.once("error", () => (exited = true));
    while (!exited) {
      const connection = await connectHost(paths);
      if (connection) return connection;
      if (Date.now() > deadline) {
        throw new InferenceError(
          `The model host did not start within ${HOST_START_MS / 1000} s. ` +
            `Its log is ${paths.log}.`,
        );
      }
      await delay(HOST_POLL_MS);
    }
    const connection = await connectHost(paths);
    if (connection) return connection;
    await delay(HOST_POLL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- the provider's path through the host --------------------------------

/** How a provider reaches the host, fixed at construction. */
export interface HostRoute extends HostedCall {
  mode: "connect" | "spawn";
  model: HostedModel;
}

/**
 * Run one provider call in the host. `local` is the same call in this
 * process, used in connect mode when no host runs.
 *
 * A host that dies mid-call is retried once: on a new host in spawn mode, or
 * locally in connect mode.
 */
export async function callModelHost<T>(
  route: HostRoute,
  call:
    | { op: "completeJSON"; request: CompleteJSONRequest }
    | { op: "decide"; request: DecideRequest }
    | { op: "completeJSONShared"; request: SharedJSONRequest }
    | { op: "stateLimit" },
  local: () => Promise<T>,
): Promise<T> {
  const paths = modelHostPaths();
  const { mode, ...frame } = route;
  for (let attempt = 0; ; attempt++) {
    const connection =
      (await connectHost(paths)) ?? (mode === "spawn" ? await startHost(paths) : undefined);
    if (!connection) return local();
    try {
      return await connection.request<T>({ ...frame, ...call } as HostFrame);
    } catch (e) {
      if (!(e instanceof HostGone)) throw e;
      if (mode === "connect") return local();
      if (attempt >= 1) {
        throw new InferenceError(
          `The model host exited twice while answering this request, so it was not ` +
            `answered. Its log is ${paths.log}.`,
        );
      }
    } finally {
      connection.close();
    }
  }
}

// --- the public functions ------------------------------------------------

export interface ModelHostStatus {
  pid: number;
  /** Each model loaded, loading or waited for. */
  models: {
    model: string;
    /** Live leases holding it. */
    sessions: number;
    /** Since its last call finished; 0 while one runs. */
    idleMs: number;
    /** Calls waiting for it, not counting the one running. */
    queued: number;
  }[];
}

/** The running host's state, or null when none runs. Never starts one. */
export async function modelHostStatus(): Promise<ModelHostStatus | null> {
  const connection = await connectHost(modelHostPaths());
  if (!connection) return null;
  try {
    return await connection.request<ModelHostStatus>({ op: "status" });
  } catch (e) {
    if (e instanceof HostGone) return null;
    throw e;
  } finally {
    connection.close();
  }
}

export interface ReleaseModelHostResult {
  /** Sessions whose leases were dropped. */
  released: string[];
  /** Models unloaded because no live lease held them any more. */
  unloaded: string[];
  /** The host stopped, because nothing was left loaded and no one else was connected. */
  hostStopped: boolean;
}

/**
 * Drop one session's leases, or with `{ all: true }` every lease, every model
 * and the host itself. Never starts a host.
 */
export async function releaseModelHost(
  options: { session: string } | { all: true },
): Promise<ReleaseModelHostResult> {
  const all = "all" in options && options.all === true;
  const session = "session" in options ? options.session : undefined;
  if (!all && (typeof session !== "string" || session === "")) {
    throw new InferenceError("releaseModelHost needs { session } or { all: true }.");
  }
  const connection = await connectHost(modelHostPaths());
  if (!connection) return { released: [], unloaded: [], hostStopped: false };
  try {
    const result = await connection.request<ReleaseModelHostResult>(
      all ? { op: "shutdown" } : { op: "release", session: session! },
    );
    // The host closes this connection last, once its models are freed.
    if (result.hostStopped) {
      await Promise.race([connection.closed, delay(HOST_EXIT_MS)]);
    }
    return result;
  } catch (e) {
    if (e instanceof HostGone) return { released: [], unloaded: [], hostStopped: false };
    throw e;
  } finally {
    connection.close();
  }
}

export interface LeaseModelHostOptions {
  /** A concrete model, as the provider accepts it: an alias, an `hf:` URI or a path. */
  model: string;
  /** Names the lease. Calls carrying the same `session` renew it. */
  session: string;
  /** Milliseconds the lease outlives its last use. Default 600000. */
  keepAlive?: number;
  /** Start a host when none runs. Default true. */
  spawn?: boolean;
  modelsDirectory?: string;
  gpu?: LlamaGpu;
  /** Milliseconds the load may wait in the host's queue. Unset: no limit. */
  hostWaitMs?: number;
}

/**
 * Take a lease on a model in the host, loading it there if needed, so the
 * calls that follow find it warm. Resolves once the model is loaded, with the
 * host's pid, or null when no host runs and `spawn` is false.
 */
export async function leaseModelHost(
  options: LeaseModelHostOptions,
): Promise<{ pid: number } | null> {
  if (typeof options.session !== "string" || options.session === "") {
    throw new InferenceError(
      `leaseModelHost needs a non-empty session, got ${JSON.stringify(options.session) ?? String(options.session)}.`,
    );
  }
  const paths = modelHostPaths();
  const connection =
    (await connectHost(paths)) ?? (options.spawn === false ? undefined : await startHost(paths));
  if (!connection) return null;
  try {
    return await connection.request<{ pid: number }>({
      op: "lease",
      session: options.session,
      keepAliveMs: options.keepAlive ?? DEFAULT_KEEP_ALIVE_MS,
      ...(options.hostWaitMs != null ? { waitMs: options.hostWaitMs } : {}),
      model: {
        model: options.model,
        modelsDirectory: options.modelsDirectory ?? defaultLlamaModelsDirectory(),
        ...(options.gpu !== undefined ? { gpu: options.gpu } : {}),
      },
    });
  } catch (e) {
    if (e instanceof HostGone) {
      throw new InferenceError(
        `The model host exited while loading "${options.model}" for a lease. Its log is ${paths.log}.`,
      );
    }
    throw e;
  } finally {
    connection.close();
  }
}
