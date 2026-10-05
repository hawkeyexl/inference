---
status: "accepted"
date: 2026-10-05
decision-makers: [hawkeyexl]
---

# Keep local models loaded across processes in an opt-in model host

## Context and Problem Statement

A `llama-cpp` provider holds its weights in a worker its own process forks (ADR 01012). The weights
live as long as that process. That suits a consumer that runs one long job. It does not suit one
that runs from Claude Code hooks, which is what manni tracevals does. Each hook is a separate,
short-lived process. So every hook pays a full model load, measured at 6.8 s for `qwen3.5-4b` on
CUDA and 14.5 s on Vulkan, start to first answer. Several hooks that finish together, such as
subagents ending at once or two sessions side by side, each load their own 2.9 GB copy.

How can a short-lived process use a model that is already loaded, without giving up the worker's
crash isolation, and without two processes racing for the same GPU memory?

## Decision Drivers

- The second process must not reload the model.
- Concurrent processes must not each load a copy, and must not oversubscribe memory.
- The ADR 01012 guarantees stay: a native abort costs a retry on the next backend, never a dead
  consumer.
- Default behaviour is unchanged. A consumer that never asks for this pays nothing.
- A caller that cannot wait, such as a hook with its own deadline, must be able to say so and get a
  distinct error.
- Memory is freed on its own. A host nobody uses must not hold a GPU forever.
- Only the user who started it can use it.

## Considered Options

- A worker per process, as today
- Today's workers, serialised by a lock file
- One host process per user that keeps models loaded and serves every process

## Decision Outcome

Chosen option: "One host process per user", because it is the only option under which a second
process does not reload the model. The host runs the existing provider unchanged, so it keeps the
worker and the backend fallback.

### Interface

```ts
interface LlamaCppProviderOptions {
  // ...the existing options, plus:
  host?: "off" | "connect" | "spawn"; // default "off"
  keepAlive?: number;                 // ms, default 600000
  session?: string;
  hostWaitMs?: number;                // ms, default: no limit
}

function leaseModelHost(options: {
  model: string; session: string; keepAlive?: number; spawn?: boolean;
  modelsDirectory?: string; gpu?: LlamaGpu; hostWaitMs?: number;
}): Promise<{ pid: number } | null>;
function modelHostStatus(): Promise<
  null | { pid: number; models: { model: string; sessions: number; idleMs: number; queued: number }[] }
>;
function releaseModelHost(options: { session: string } | { all: true }):
  Promise<{ released: string[]; unloaded: string[]; hostStopped: boolean }>;

class ModelHostBusyError extends InferenceError {} // name "ModelHostBusyError"
```

`ProviderSpec.llamaCpp` is `LlamaCppProviderOptions`, so the factories take the new options as they
are. `"off"` is today's path, byte for byte. `"connect"` uses a running host and otherwise falls back
to `"off"`. `"spawn"` starts a host when none runs. An injected `runtime` ignores `host`, because a
runtime in this process cannot cross into another.

### The host

The host is `llama-hostd.js`, a third build entry beside `index.js` and `llama-worker.js`. A client
that finds none starts it with `spawn(process.execPath, [entry], { detached: true, windowsHide: true })`
and unrefs it, with stderr going to `host.log`. Inside, it builds a `LlamaCppProvider` per call from
the call's options and runs `completeJSON`, `decide` or `stateLimit` on it. The provider's
process-wide `loadedModels` map is what keeps the weights. Everything below the provider is the
code a consumer's own process runs: the worker, the CUDA → Vulkan → CPU fallback and context sizing.
The failed-backend set is per process, so it now lasts for the host's lifetime.

### Transport and authentication

The transport is Node's `net`. On Windows it is a named pipe,
`\\.\pipe\hawkeyexl-inference-<user>-<hash>`. Elsewhere it is a Unix socket at
`<runtime dir>/host/host.sock`, in a directory created 0700. `<user>` is the sanitised user name, and
`<hash>` is a hash of the host directory. So `INFERENCE_RUNTIME_DIR` gives a test, or a second
install, a host of its own. At start the host writes 32 random bytes to `host.token`, mode 0600. A
client's first frame must be `hello` with that token. A wrong token gets an error reply and the
connection closed; any other first frame closes it without a word. An unauthenticated connection is
closed after 10 s.

The host takes a start lock, `host.lock`, through the same `withDirLock` the install and the
downloads use. The lock holds its pid. A second host started at the same moment finds it held and
exits; the client keeps connecting, and launches again only once its own launch has exited and
nothing answers. A lock whose pid is dead is reclaimed, and a stale Unix socket file is removed
before listening.

### Protocol

Frames are newline-delimited JSON. A request is `{ id, op, ... }`. A reply is
`{ id, ok: true, value }` or `{ id, ok: false, error: { name, message } }`. The client rebuilds
`InferenceError` and `ModelHostBusyError` by name, as `llama-host.ts` does for the worker. The ops are
`hello`, `completeJSON`, `decide`, `stateLimit`, `lease`, `release`, `status` and `shutdown`.
`stateLimit` is there because `DecisionProvider` requires it and it needs the loaded model. Every
model op carries its model and provider options, `keepAliveMs`, and optionally `session` and
`waitMs`. A client opens one connection per call and closes it after.

### Queue and memory

There is one FIFO per model, and one call per model in flight. Calls for different models run side
by side only if `fits` (ADR 01014) says the second fits beside the first, measured against free
memory now. Otherwise the host unloads idle models, least recently used first, until it fits. A call
that must wait for memory holds back every call that arrived after it, so a busy model cannot starve
it. A call still queued past its `waitMs` is withdrawn with `ModelHostBusyError`. A distinct class
and `name` let a consumer tell "busy, nothing ran" from a failure without parsing the message.

### Lifetime

A model stays loaded while it is busy or queued, while a live lease holds it, and for its keepAlive
after its last call. The keepAlive is the latest call's, default 600000 ms; `0` unloads it as soon as
nothing holds it. A lease is `{ session, keepAliveMs }`. A call carrying `session` takes it, or
renews an existing one, and a lease keeps the keepAlive it was taken with. It lapses when unused for
that long. `releaseModelHost({ session })` drops the session's leases and unloads what no other
lease holds. `{ all: true }` withdraws the queue, waits for running calls, unloads everything and
stops the host. Both resolve after the memory is freed. The host exits when nothing is loaded and no
client is connected. One that no client reaches within 60 s of starting exits too.

### Failure

A host that dies mid-call, killed or crashed, closes the connection. In spawn mode the client
starts a new host and retries once; a second death is an `InferenceError`. In connect mode it falls
back to its own worker and retries there. A native abort inside the host's worker is handled inside
the host, as before, and never reaches the client as a host death.

### Consequences

- Good, because a second process answers from a loaded model. On an RTX 4090 with `qwen3.5-4b`, a
  judge call took 6.8 s from a cold start with a load and 1.1 s from a second client on CUDA. On
  Vulkan the same two took 14.5 s and 1.7 s.
- Good, because concurrent processes share one copy and are serialised per model, so they no longer
  oversubscribe the GPU.
- Good, because the default is unchanged and nothing starts unless a consumer opts in.
- Bad, because a model can stay resident for up to `keepAlive` after the last call, holding memory
  another program might want. `0`, a short keepAlive, or `releaseModelHost` give it back.
- Bad, because the host's warnings, including backend switches, go to `host.log` rather than the
  consumer's console.
- Bad, because a long call holds back every later call for its model. That is the price of one copy
  of the weights. `hostWaitMs` bounds what a caller pays for it.
- Neutral, because a host from one release serves clients from another only as far as the protocol
  is unchanged. A mismatch shows as an unknown-operation error, and stopping the host clears it.

### Confirmation

`test/unit/model-host.test.ts` forks the real host from `src/` with the fake llama backend, over
real pipes and sockets in a temporary runtime directory. It covers a second client process reusing
the model, counted from the backend's load log, and FIFO order with one call in flight. It also
covers `hostWaitMs` withdrawal, keepAlive unload and exit, keepAlive 0, and lease preload, renewal
and lapse. `release` for one session and for all is there, with `status`, refused tokens, a
reclaimed lock and socket, and a host killed mid-call. So are connect-mode use and fallback,
`decide` and `stateLimit`, and eviction when a second model does not fit. The live suite
(`INFERENCE_LIVE_LLAMA`) runs the host over the real binding and logs both latencies.

## Pros and Cons of the Options

### A worker per process, as today

- Good, because nothing is shared, so nothing can be contended or leaked.
- Bad, because every short-lived process pays the full load, which is most of a hook's run time.
- Bad, because concurrent processes each load a copy and can exhaust GPU memory together.

### Today's workers, serialised by a lock file

- Good, because it stops concurrent copies from oversubscribing memory, with little new code.
- Bad, because each process still loads the model once it holds the lock, so the load is paid every
  time, now one after another.

### One host process per user

- Good, because it is the only option where the second process skips the load.
- Good, because the queue serialises access to one copy and the memory check governs two models.
- Bad, because it adds a long-lived process, a transport, authentication and a lifetime policy to a
  library that had none.
- Neutral, because it is opt-in, so consumers that do not need it see no change.
