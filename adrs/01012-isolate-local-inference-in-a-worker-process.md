---
status: "accepted"
date: 2026-10-03
decision-makers: [hawkeyexl]
---

# Run local inference in a worker process, and fall back from a GPU backend that crashes it

## Context and Problem Statement

On Windows 11 with an RTX 4090 (driver 610.88), node-llama-cpp's prebuilt CUDA backend
intermittently aborts the process during generation:

```text
D:\a\node-llama-cpp\node-llama-cpp\llama\llama.cpp\ggml\src\ggml-cuda\ggml-cuda.cu:106: CUDA error
```

The process exits with code 127. This is `GGML_ABORT`, a native abort: no JavaScript exception is
thrown, so no `try`, no `completeValidatedJSON`, and no consumer can catch it. With llama.cpp in the
consumer's process, as ADR 01003 put it, the abort ended the consumer. manni lost the whole run and
everything already computed in it.

That breaks this library's central safety property: an errored run is recorded, never dropped.
A crash didn't produce an errored run. It produced no run at all.

Facts established in manni on 2026-10-03:

- It happens on node-llama-cpp 3.19.1 and on 3.22.1 (6 of 6 runs), always inside
  `session.promptWithMeta`, after the model, context and grammar are all created.
- The rate depends on the host process. The manni CLI crashes about 100% of the time, manni's
  programmatic `runFill` about 1 in 6, and a small standalone script doing the same call 0 times in
  about 15. A pre-flight probe in a fresh process would usually pass while the real run still
  crashes.
- None of these stop it: `GGML_CUDA_DISABLE_GRAPHS`, `CUDA_LAUNCH_BLOCKING`, `GGML_CUDA_FORCE_CUBLAS`,
  `GGML_CUDA_NO_PINNED`, `GGML_CUDA_FORCE_MMQ`. Memory pressure, concurrency and `maxTokens` are
  ruled out as causes.
- Vulkan on the same GPU is stable: 12 s per judge call, no crashes. The CPU is stable too, but
  about 50× slower (628 s per call).

## Decision Drivers

- A native crash in llama.cpp must cost a retry or an errored run, never the consumer's process.
- Only the backend is unreliable. The model, the prompt and the answer are fine, so the same
  request should be retried somewhere that works.
- A backend the user chose explicitly is honoured, never silently replaced.
- The provider contract, `JudgeRun`, the cache format, and the `LlamaRuntime` seam stay as they
  are. Consumers' fakes keep working.
- Loading weights costs seconds and gigabytes, so it can't happen per call.
- A consumer that never calls `disposeLlamaModels` must still exit when its work is done.

## Considered Options

- A pre-flight probe that picks a backend before the run
- A worker process per call
- A worker process per loaded model
- A worker process per requested backend, holding its loaded models
- Disable CUDA by default

## Decision Outcome

Chosen option: "A worker process per requested backend". It is the only option that survives a
crash whose rate no probe can predict, and it still pays for the GPU initialisation and the weight
load once.

### The boundary

The boundary is behind the existing `LlamaRuntime` seam. `defaultLlamaRuntime()` now returns a
runtime whose loads, sessions, prompts, token counts and memory probe are IPC requests to a forked
child, `llama-worker.js`, which owns node-llama-cpp. `LlamaCppProvider` is unchanged in
everything it decides: context sizing (ADR 01011), the truncation guards, and the brace repair
(ADR 01010). An injected runtime still runs in-process, exactly as before.

The worker is forked with `stdio: [ignore, inherit, pipe, ipc]` and JSON serialisation. Prompts
travel over the IPC pipe, never argv. The worker's stderr is forwarded live, and its last 20 lines
are kept so the parent can name what killed it. The child and its pipes are unreferenced whenever
no request is in flight, so an idle worker never holds a consumer's process open. When the parent
exits, crashes or is killed, the child sees `disconnect` and exits too. `disposeLlamaModels()`
disposes the models and stops the workers, killing one that hasn't exited within 5 s.

The worker file imports only Node builtins at runtime, because the test suite forks it straight
from `src/` and Node's type stripping can't map a sibling `.js` import to its `.ts`. It's built
as a second tsup entry beside `index.js`. If it's missing, which happens when a consumer bundles
this library into a file of its own, the runtime runs in-process as before and warns once that
there is no crash isolation.

A side effect: the consumer's process never initialises a GPU backend. The tier probe used to call
`getLlama()` in the parent. Now it runs in the same worker that later serves the calls, so the
~1 s initialisation is paid once.

### Crash versus error

| In the worker | Treated as | Effect |
|---|---|---|
| A handler throws (context overflow, a grammar error, `NoBinaryFoundError`, a missing file) | error | Re-thrown with the same name and message. No retry, and the worker stays. |
| The process exits or is signalled, with any code, while requests are in flight (including `init` and `loadModel`) | crash | Every in-flight request goes to the fallback. |
| The process exits while idle | neither | The next request starts a new worker on the same backend. |

### The fallback

The first worker asks for `getLlama({ gpu: "auto" })`, as before. Before initialising, it names the
backend it is about to try, so a crash *during* initialisation is attributable too. When a worker on
backend B crashes:

- If the backend was chosen explicitly, through `llamaCpp.gpu` or `NODE_LLAMA_CPP_GPU`, the call
  fails with an `InferenceError` that names the crash and the setting, and `completeValidatedJSON`
  records it as an errored run. Someone who pinned CUDA is benchmarking or debugging it, and quietly
  running their work on Vulkan would misreport it.
- Otherwise B is added to a process-wide list of failed backends. A new worker asks for
  `{ type: "auto", exclude: [...failed] }` with `build: "never"`, so a fallback can't start a
  multi-minute CMake build. The same request is then retried there: the model is reloaded from the
  same path, the session recreated with the same prompt and context size, and the prompt sent again.
  A prompt has no side effects, so retrying it is safe. One warning names the switch.
- CPU is the last resort, with a louder warning, because it is about 50× slower. Losing the run is
  worse, and anyone who would rather fail fast can pin a backend.
- A crash on the CPU is not recorded. At that point the request is the likelier cause, so the call
  fails with an `InferenceError` listing every backend's exit, and later calls may still use the CPU.

Concurrent calls that see the same crash decide it once. That gives one warning, one replacement
worker, and every call retried on it.

### The backend is not part of the identity

`ProviderIdentity`, the cache key and `JudgeRun` don't change. The cache key names what produced an
answer: the weights and the prompt. CUDA and Vulkan run the same GGUF under the same grammar and
differ only in floating-point rounding, which is the same variation two GPUs or two driver versions
already produce under one key. Keying on the backend would make the key depend on a crash that
differs from run to run, so the run after a fallback would miss every entry the fallback wrote and
pay for the work again. `JudgeRun` is a file format, and consumers own their cache keys. The switch
is reported by a warning instead.

### Interface

- `LlamaCppProviderOptions.gpu?: "auto" | "cuda" | "vulkan" | "metal" | false`, and the
  `LlamaGpu` type. Unset, `NODE_LLAMA_CPP_GPU` decides, read the way node-llama-cpp reads it.
- `defaultLlamaRuntime(options?: { gpu?: LlamaGpu })`. The call with no arguments is unchanged.
- `LlamaLoadedModel.countTokens` may return a `Promise<number>`, because the tokenizer is in the
  worker. Implementers still compile, and the provider awaits it.
- The real runtime returns object literals, as before, so a wrapper that spreads a model or session
  keeps its methods.

### Consequences

- Good, because a CUDA abort costs one retry and one warning instead of the consumer's process, and
  only once per process.
- Good, because a crash nobody can recover from (a pinned backend, or every backend) is an errored
  run. The safety property holds again.
- Good, because the consumer's process no longer initialises a GPU, so a crash anywhere in
  llama.cpp's native code is contained.
- Neutral, because each call adds an IPC round trip or two, which is microseconds next to seconds of
  generation.
- Bad, because the machine runs one more Node process per backend in use, about 50 MB beside
  gigabytes of weights.
- Bad, because a *hang* in the worker is not a crash and still blocks the call. The contract has no
  cancellation, and any fixed timeout would be wrong for a 10-minute CPU call.
- Bad, because a consumer that bundles this library into one file loses the isolation. It is warned
  once.

### Confirmation

- `test/unit/llama-worker.test.ts` forks the real worker with a stand-in for node-llama-cpp
  (`test/support/fake-llama-backend.mjs`), whose crashes are real `process.abort()`s. It pins:
  fallback from a crash in `init`, `loadModel` and `prompt`; one warning per switch; the remembered
  backend; the CPU last resort; the errored run when every backend crashes; explicit choices that
  never switch; ordinary errors that pass through on the same worker; concurrent calls sharing one
  replacement; spread-safe objects; a real parent process that exits on its own; and a killed parent
  that takes its worker with it. One test loads the real node-llama-cpp in the worker and asserts the
  contract only.
- `test/unit/build.test.ts` pins `llama-worker` as a build entry, and `test/unit/source-hygiene.test.ts`
  pins the worker's builtins-only imports.
- `test/integration/live-llama.test.ts`, gated on `INFERENCE_LIVE_LLAMA`, runs real weights through
  the worker.

### Commit type

`feat`. The change adds a public option and type, and it changes what the default runtime does on
purpose. It is not breaking. Nothing is removed or renamed, and the provider contract, `JudgeRun` and
the cache format are unchanged. The one widened type, `countTokens`, affects only code that calls the
seam directly.

This amends ADR 01003 in one respect: local models still run through node-llama-cpp, but no longer
in the consumer's process.

## Pros and Cons of the Options

### A pre-flight probe

- Good, because it is simple, and once chosen a backend runs in-process with no IPC.
- Bad, because it does not work. The crash rate depends on the host process: 0 of 15 in a small
  script, about 100% in the manni CLI. A probe would pass, and the run would still die.

### A worker per call

- Good, because each call is fully isolated.
- Bad, because every call reloads 1.4–6 GB of weights and reinitialises the GPU.

### A worker per loaded model

- Good, because a crash takes down only one model.
- Bad, because every model initialises the GPU again, and the tier probe would need a worker of its
  own. In practice a consumer loads one model.

### A worker per requested backend (chosen)

- Good, because the GPU is initialised once, and the probe and the calls share it.
- Good, because the fallback is a property of the worker, invisible to the provider.
- Bad, because a crash interrupts every model loaded in that worker. Each one is reloaded on the
  next backend.

### Disable CUDA by default

- Good, because it is a one-line change.
- Bad, because it gives up the fastest backend on every machine where CUDA works, to work around one
  driver. It also still leaves any other native abort fatal.
