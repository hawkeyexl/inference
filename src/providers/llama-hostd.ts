/**
 * The model host: a detached process that keeps local models loaded for the
 * short-lived processes that call them. Started by `model-host.ts` when a
 * client finds none running. ADR 01017.
 *
 * It runs `LlamaCppProvider` itself, so everything the provider does — the
 * worker process, the CUDA → Vulkan → CPU fallback, context sizing — is
 * unchanged; only where the provider lives moves. Calls for one model run one
 * at a time, in arrival order. A second model loads beside the first only if
 * `fits` says it does; otherwise the first is unloaded once idle.
 *
 * A model unloads when no live lease holds it and it has been idle for its
 * keepAlive. The host exits when nothing is loaded and no client is connected.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { InferenceError } from "../types.js";
import {
  LlamaCppProvider,
  disposeLlamaModels,
  isLlamaModelLoaded,
  llamaModelKey,
  unloadLlamaModel,
} from "./llama-cpp.js";
import { fits } from "./llama-lifecycle.js";
import { withDirLock } from "./llama-install.js";
import { HOST_LOCK, ModelHostBusyError, ensureHostDir, modelHostPaths } from "./model-host.js";
import type {
  HostFrame,
  HostReply,
  HostedModel,
  ModelHostPaths,
  ModelHostStatus,
  ReleaseModelHostResult,
} from "./model-host.js";

/** A host no client reaches within this exits; nothing would ever stop it. */
const START_GRACE_MS = 60_000;
/** An unauthenticated connection must say hello within this. */
const HELLO_MS = 10_000;
/** The longest delay `setTimeout` honours; anything longer fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

type Frame = HostFrame & { id: number };
type QueuedFrame = Extract<Frame, { model: HostedModel }>;

interface Model {
  key: string;
  /** As the first call named it; what `status` reports. */
  name: string;
  spec: HostedModel;
  loaded: boolean;
  busy: boolean;
  lastUsed: number;
  /** From the latest call. */
  keepAliveMs: number;
}

interface Lease {
  keepAliveMs: number;
  lastUsed: number;
}

interface Job {
  frame: QueuedFrame;
  key: string;
  socket: Socket;
  timer?: NodeJS.Timeout;
}

function errorOf(e: unknown): { name: string; message: string } {
  return e instanceof Error
    ? { name: e.name, message: e.message }
    : { name: "Error", message: String(e) };
}

class ModelHost {
  private readonly models = new Map<string, Model>();
  /** Session → model key → lease. */
  private readonly leases = new Map<string, Map<string, Lease>>();
  private readonly queue: Job[] = [];
  private readonly clients = new Set<Socket>();
  private readonly running = new Set<Promise<void>>();
  private readonly token = randomBytes(32).toString("hex");
  private server: Server | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  /** Set once a client has connected or the start grace has passed. */
  private live = false;
  private stopping = false;
  private pumping = false;
  private pumpAgain = false;
  private finished!: () => void;
  private readonly done = new Promise<void>((resolve) => (this.finished = resolve));

  constructor(private readonly paths: ModelHostPaths) {}

  /** Serve until stopped. Resolves once every model is freed. */
  async serve(): Promise<void> {
    // A socket a dead host left behind; the start lock says none is alive.
    if (process.platform !== "win32") rmSync(this.paths.socket, { force: true });
    rmSync(this.paths.token, { force: true });
    writeFileSync(this.paths.token, this.token, { mode: 0o600 });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(this.paths.socket, () => resolve(true));
    });
    if (!listening) return;
    setTimeout(() => {
      this.live = true;
      this.maybeStop();
    }, START_GRACE_MS).unref();
    await this.done;
  }

  // --- connections -------------------------------------------------------

  private accept(socket: Socket): void {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    this.clients.add(socket);
    this.live = true;
    let authed = false;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(HELLO_MS, () => {
      if (!authed) socket.destroy();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.clients.delete(socket);
      for (const job of this.queue.filter((j) => j.socket === socket)) this.withdraw(job);
      this.sweep();
    });
    socket.on("data", (chunk: string) => {
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (socket.destroyed) return;
        let frame: Frame;
        try {
          frame = JSON.parse(line) as Frame;
        } catch {
          socket.destroy();
          return;
        }
        if (authed) {
          this.handle(frame, socket);
        } else if (frame.op === "hello" && this.tokenMatches(frame.token)) {
          authed = true;
          socket.setTimeout(0);
          this.reply(socket, { id: frame.id, ok: true, value: { pid: process.pid } });
        } else if (frame.op === "hello") {
          this.reply(socket, {
            id: frame.id,
            ok: false,
            error: errorOf(
              new InferenceError(
                `The model host refused this client: its token does not match ${this.paths.token}.`,
              ),
            ),
          });
          socket.end();
          return;
        } else {
          socket.destroy();
          return;
        }
      }
    });
  }

  private tokenMatches(token: unknown): boolean {
    if (typeof token !== "string") return false;
    const given = Buffer.from(token);
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private reply(socket: Socket, reply: HostReply): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
  }

  private handle(frame: Frame, socket: Socket): void {
    switch (frame.op) {
      case "status":
        this.reply(socket, { id: frame.id, ok: true, value: this.status() });
        return;
      case "release":
        void this.release(frame, socket);
        return;
      case "shutdown":
        void this.shutdown(frame, socket);
        return;
      case "completeJSON":
      case "decide":
      case "completeJSONShared":
      case "stateLimit":
      case "lease":
        this.enqueue(frame, socket);
        return;
      default:
        this.reply(socket, {
          id: frame.id,
          ok: false,
          error: errorOf(
            new InferenceError(
              `The model host does not know the operation ${JSON.stringify(frame.op)}.`,
            ),
          ),
        });
    }
  }

  // --- the queue ---------------------------------------------------------

  private enqueue(frame: QueuedFrame, socket: Socket): void {
    if (this.stopping) {
      this.reply(socket, {
        id: frame.id,
        ok: false,
        error: errorOf(new InferenceError("The model host is stopping and took no new requests.")),
      });
      return;
    }
    let key: string;
    try {
      key = llamaModelKey(frame.model.modelsDirectory, frame.model.model);
    } catch (e) {
      this.reply(socket, { id: frame.id, ok: false, error: errorOf(e) });
      return;
    }
    if (!this.models.has(key)) {
      this.models.set(key, {
        key,
        name: frame.model.model,
        spec: frame.model,
        loaded: false,
        busy: false,
        lastUsed: Date.now(),
        keepAliveMs: frame.keepAliveMs,
      });
    }
    const job: Job = { frame, key, socket };
    const waitMs = frame.waitMs;
    if (waitMs != null) {
      job.timer = setTimeout(
        () =>
          this.withdraw(
            job,
            new ModelHostBusyError(
              `The request for "${frame.model.model}" waited ${waitMs} ms in the model host's ` +
                `queue without starting, so it was withdrawn (hostWaitMs). Nothing ran.`,
            ),
          ),
        Math.min(waitMs, MAX_TIMER_MS),
      );
    }
    this.queue.push(job);
    void this.pump();
  }

  /** Take a job off the queue, telling its client why when there is one to tell. */
  private withdraw(job: Job, reason?: Error): void {
    const index = this.queue.indexOf(job);
    if (index < 0) return;
    this.queue.splice(index, 1);
    clearTimeout(job.timer);
    if (reason) this.reply(job.socket, { id: job.frame.id, ok: false, error: errorOf(reason) });
    this.sweep();
  }

  /**
   * Start what can start, in arrival order. A call whose model must wait for
   * memory holds back every call behind it, so a busy model cannot starve it.
   */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (const job of [...this.queue]) {
          const model = this.models.get(job.key);
          if (!model || model.busy || !this.queue.includes(job)) continue;
          if (!model.loaded && !(await this.makeRoomFor(model))) break;
          if (model.busy || !this.queue.includes(job)) continue;
          this.start(job, model);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  /** True once `model` can load: it fits, or idle models were unloaded until it does. */
  private async makeRoomFor(model: Model): Promise<boolean> {
    for (;;) {
      const others = [...this.models.values()].filter(
        (m) => m !== model && (m.loaded || m.busy),
      );
      if (others.length === 0) return true;
      const room = await fits(model.spec.model, {
        modelsDirectory: model.spec.modelsDirectory,
        ...(model.spec.gpu !== undefined ? { gpu: model.spec.gpu } : {}),
      }).catch(() => undefined);
      // A model that cannot be sized is let try; its load says what is wrong.
      if (!room || room.fits) return true;
      const idle = others.filter((m) => !m.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) return false;
      await this.unload(idle);
    }
  }

  private start(job: Job, model: Model): void {
    this.queue.splice(this.queue.indexOf(job), 1);
    clearTimeout(job.timer);
    model.busy = true;
    model.keepAliveMs = job.frame.keepAliveMs;
    const running = this.run(job.frame).then(
      (value) => this.reply(job.socket, { id: job.frame.id, ok: true, value }),
      (e: unknown) => this.reply(job.socket, { id: job.frame.id, ok: false, error: errorOf(e) }),
    );
    const settled = running.finally(() => {
      this.running.delete(settled);
      model.busy = false;
      model.lastUsed = Date.now();
      model.loaded = isLlamaModelLoaded(model.key);
      if (job.frame.session && model.loaded) this.touchLease(job.frame.session, job.frame);
      this.sweep();
      void this.pump();
    });
    this.running.add(settled);
  }

  private async run(frame: QueuedFrame): Promise<unknown> {
    const { model, modelsDirectory, gpu, contextSize, thoughtTokens, maxTokens } = frame.model;
    const provider = new LlamaCppProvider(model, {
      modelsDirectory,
      ...(gpu !== undefined ? { gpu } : {}),
      ...(contextSize != null ? { contextSize } : {}),
      ...(thoughtTokens != null ? { thoughtTokens } : {}),
      ...(maxTokens != null ? { maxTokens } : {}),
    });
    switch (frame.op) {
      case "completeJSON":
        return provider.completeJSON(frame.request);
      case "decide":
        return provider.decide(frame.request);
      case "completeJSONShared":
        return provider.completeJSONShared(frame.request);
      case "stateLimit":
        return provider.stateLimit();
      case "lease":
        // Loads the weights; the count itself is not needed.
        await provider.stateLimit();
        return { pid: process.pid };
    }
  }

  // --- leases and unloading ----------------------------------------------

  /** Take the lease, or renew it: a lease keeps the keepAlive it was taken with. */
  private touchLease(session: string, frame: QueuedFrame): void {
    const held = this.leases.get(session) ?? new Map<string, Lease>();
    this.leases.set(session, held);
    const key = llamaModelKey(frame.model.modelsDirectory, frame.model.model);
    const lease = held.get(key);
    if (lease) lease.lastUsed = Date.now();
    else held.set(key, { keepAliveMs: frame.keepAliveMs, lastUsed: Date.now() });
  }

  private held(key: string, now: number): number {
    let count = 0;
    for (const held of this.leases.values()) {
      const lease = held.get(key);
      if (lease && now - lease.lastUsed < lease.keepAliveMs) count++;
    }
    return count;
  }

  private queued(key: string): number {
    return this.queue.filter((j) => j.key === key).length;
  }

  private async unload(model: Model): Promise<void> {
    model.loaded = false;
    await unloadLlamaModel(model.key);
  }

  /**
   * Drop lapsed leases, unload what nothing holds, and wake again when the
   * next lease or keepAlive runs out.
   */
  private sweep(): void {
    if (this.stopping) return;
    clearTimeout(this.sweepTimer);
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const [session, held] of this.leases) {
      for (const [key, lease] of held) {
        const ends = lease.lastUsed + lease.keepAliveMs;
        if (ends <= now) held.delete(key);
        else next = Math.min(next, ends);
      }
      if (held.size === 0) this.leases.delete(session);
    }
    for (const model of [...this.models.values()]) {
      if (model.busy || this.queued(model.key) > 0) continue;
      if (!model.loaded) {
        this.models.delete(model.key);
        continue;
      }
      if (this.held(model.key, now) > 0) continue;
      const ends = model.lastUsed + model.keepAliveMs;
      if (ends <= now) {
        this.models.delete(model.key);
        void this.unload(model).then(() => this.maybeStop());
      } else {
        next = Math.min(next, ends);
      }
    }
    if (next !== Number.POSITIVE_INFINITY) {
      this.sweepTimer = setTimeout(() => this.sweep(), Math.min(next - now, MAX_TIMER_MS));
    }
    this.maybeStop();
  }

  private status(): ModelHostStatus {
    const now = Date.now();
    return {
      pid: process.pid,
      models: [...this.models.values()]
        .filter((m) => m.loaded || m.busy || this.queued(m.key) > 0)
        .map((m) => ({
          model: m.name,
          sessions: this.held(m.key, now),
          idleMs: m.busy ? 0 : now - m.lastUsed,
          queued: this.queued(m.key),
        })),
    };
  }

  private async release(frame: Extract<Frame, { op: "release" }>, socket: Socket): Promise<void> {
    const held = this.leases.get(frame.session);
    this.leases.delete(frame.session);
    const unloaded: string[] = [];
    const now = Date.now();
    for (const key of held?.keys() ?? []) {
      const model = this.models.get(key);
      if (!model?.loaded || model.busy || this.queued(key) > 0 || this.held(key, now) > 0) continue;
      this.models.delete(key);
      unloaded.push(model.name);
      await this.unload(model);
    }
    const hostStopped = this.idle(socket);
    const result: ReleaseModelHostResult = {
      released: held ? [frame.session] : [],
      unloaded,
      hostStopped,
    };
    if (!hostStopped) {
      this.reply(socket, { id: frame.id, ok: true, value: result });
      this.sweep();
      return;
    }
    await this.stop(() => this.reply(socket, { id: frame.id, ok: true, value: result }));
  }

  private async shutdown(frame: Extract<Frame, { op: "shutdown" }>, socket: Socket): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const job of [...this.queue]) {
      this.queue.splice(this.queue.indexOf(job), 1);
      clearTimeout(job.timer);
      this.reply(job.socket, {
        id: job.frame.id,
        ok: false,
        error: errorOf(
          new InferenceError(
            "The model host was stopped by releaseModelHost({ all: true }) before this request ran.",
          ),
        ),
      });
    }
    await Promise.all(this.running);
    const result: ReleaseModelHostResult = {
      released: [...this.leases.keys()],
      unloaded: [...this.models.values()].filter((m) => m.loaded).map((m) => m.name),
      hostStopped: true,
    };
    this.leases.clear();
    await this.stop(() => this.reply(socket, { id: frame.id, ok: true, value: result }));
  }

  /** Nothing loaded, loading or waiting, and no client but `except`. */
  private idle(except?: Socket): boolean {
    const others = [...this.clients].filter((c) => c !== except).length;
    return (
      others === 0 &&
      this.queue.length === 0 &&
      [...this.models.values()].every((m) => !m.loaded && !m.busy)
    );
  }

  private maybeStop(): void {
    if (this.live && !this.stopping && this.idle()) void this.stop();
  }

  /**
   * Stop listening, say `last` to whoever asked, free every model and worker,
   * and only then close the remaining connections — so a client waiting on
   * its connection to close knows the memory is free.
   */
  private async stop(last?: () => void): Promise<void> {
    this.stopping = true;
    clearTimeout(this.sweepTimer);
    this.server?.close();
    last?.();
    await disposeLlamaModels();
    for (const client of this.clients) client.destroy();
    this.finished();
  }
}

async function main(): Promise<void> {
  const paths = modelHostPaths();
  ensureHostDir(paths.dir);
  // A second host started at the same moment finds the lock held and exits;
  // a lock whose holder died is reclaimed.
  await withDirLock(paths.dir, () => new ModelHost(paths).serve(), {
    name: HOST_LOCK,
    isDone: () => true,
    what: "start the model host",
    waitMs: 0,
    staleMs: Number.POSITIVE_INFINITY,
  });
}

await main();
process.exit(0);
