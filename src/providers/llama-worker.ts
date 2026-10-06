/**
 * The local-model worker: a child process that owns node-llama-cpp.
 *
 * llama.cpp reports a fatal GPU error by aborting the process (GGML_ABORT).
 * In-process, that ended the consumer — every result it had computed, gone,
 * with no exception to catch. Here it ends only this worker, and the parent
 * sees a child that exited mid-request, which it can retry on another backend.
 * ADR 01012.
 *
 * This file is forked straight from `src/` under the test suite, where Node
 * strips its types but cannot map a sibling's `.js` import to its `.ts`. So it
 * imports only Node builtins at runtime — `source-hygiene.test.ts` pins that.
 * Types are erased, so `import type` from siblings is fine.
 */
import { totalmem } from "node:os";
import type { ChatWrapper, LlamaGrammar, Token } from "node-llama-cpp";
import type {
  LlamaDecideOptions,
  LlamaDecideResult,
  LlamaDecideReuse,
  LlamaPromptOptions,
  LlamaPromptResult,
  LlamaSharedOptions,
  LlamaSharedResult,
} from "./llama-cpp.js";

/** A llama.cpp backend, as node-llama-cpp names it; `false` is the CPU. */
export type WorkerGpu = "metal" | "cuda" | "vulkan" | false;

/** What `getLlama` is asked for: one backend, or the best one not excluded. */
export type WorkerGpuRequest =
  | "auto"
  | WorkerGpu
  | { type: "auto"; exclude: WorkerGpu[] };

export interface WorkerBackendOptions {
  gpu: WorkerGpuRequest;
  /**
   * `"never"` on a fallback, so switching backends uses a prebuilt binary or
   * fails — it never starts a multi-minute CMake build mid-run.
   */
  build?: "never";
}

export interface WorkerBackendHooks {
  /**
   * Names the backend about to initialise, before it does. A crash inside
   * initialisation is then attributable, so the fallback knows what to skip.
   */
  trying(gpu: WorkerGpu): void;
}

export interface WorkerSession {
  readonly contextSize?: number;
  prompt(text: string, options: LlamaPromptOptions): Promise<LlamaPromptResult>;
  /** The session's context sequence, which `decideOn` drives. */
  readonly sequence?: DecideSequence;
  dispose(): Promise<void>;
}

/**
 * The parts of a context sequence a decision or a shared-prefix completion
 * uses: node-llama-cpp's, or the test suite's stand-in. Tokens are plain
 * numbers here.
 */
export interface DecideSequence {
  /**
   * The whole chat for one prompt, with thinking off, ending inside the opened
   * answer (after `answerPrefix`, which may be empty), as tokens.
   */
  render(user: string, answerPrefix: string): number[];
  /** Every single token that spells `label` as the next token, with or without a leading space. */
  labelTokens(label: string): number[];
  /** Hybrid and recurrent models cannot erase; they restore a checkpoint instead. */
  readonly needsCheckpoints: boolean;
  readonly nextTokenIndex: number;
  /** Input tokens evaluated so far, including any re-evaluation an erase caused. */
  inputTokens(): number;
  evaluate(tokens: number[]): Promise<void>;
  /** Snapshot the state here, when `needsCheckpoints`; otherwise nothing. */
  takeCheckpoint(): Promise<void>;
  /**
   * Evaluate `tokens` and return the next-token distribution after the last
   * one: the whole vocabulary, or with `topK` only the `topK` most likely.
   */
  probe(tokens: number[], topK?: number): Promise<Map<number, number>>;
  /** Remove tokens `[start, end)`, restoring or re-evaluating what remains as needed. */
  erase(start: number, end: number): Promise<void>;
  /**
   * Evaluate `tokens`, then yield each token generated under the schema's
   * grammar, ending before an end-of-generation token. A yielded token is in
   * the context once the next one is asked for.
   */
  generate(
    tokens: number[],
    options: { schema: Record<string, unknown>; temperature: number },
  ): AsyncIterable<number>;
  detokenize(tokens: number[]): string;
}

/**
 * Evaluate the tokens every prompt shares once, then run `each` on each
 * prompt's own tail, erasing back to the shared start between prompts.
 * ADR 01016; completions reuse it (ADR 01018).
 *
 * Whether the erase kept the shared start is read from the token meter, not
 * assumed: a model that cannot erase and has no usable checkpoint makes
 * node-llama-cpp evaluate the start again, and that shows as input tokens.
 */
async function onSharedStart<T>(
  sequence: DecideSequence,
  rendered: number[][],
  /** `rewind` erases back to the shared start, so a prompt can run its tail again. */
  each: (tail: number[], i: number, rewind: () => Promise<void>) => Promise<T>,
): Promise<{ results: T[]; inputTokens: number; reuse?: LlamaDecideReuse }> {
  const shared = sharedPrefixLength(rendered);
  const start = sequence.inputTokens();
  if (shared > 0) await sequence.evaluate(rendered[0]!.slice(0, shared));
  if (sequence.needsCheckpoints) await sequence.takeCheckpoint();

  let reuse: LlamaDecideReuse | undefined;
  const results: T[] = [];
  for (const [i, tokens] of rendered.entries()) {
    if (i > 0) {
      const before = sequence.inputTokens();
      await sequence.erase(shared, sequence.nextTokenIndex);
      if (sequence.inputTokens() > before) reuse = "reevaluate";
      else reuse ??= sequence.needsCheckpoints ? "checkpoint" : "erase";
    }
    results.push(
      await each(tokens.slice(shared), i, () => sequence.erase(shared, sequence.nextTokenIndex)),
    );
  }
  return {
    results,
    inputTokens: sequence.inputTokens() - start,
    ...(reuse ? { reuse } : {}),
  };
}

function sequenceOf(session: WorkerSession): DecideSequence {
  if (!session.sequence) {
    throw new Error("This local-model session has no context sequence to decide on.");
  }
  return session.sequence;
}

/**
 * How many of the most likely next tokens a decision reads. The whole
 * vocabulary is six figures of entries, and building that distribution was
 * most of a question's cost. A label outside these weighs 0. ADR 01019.
 */
const DECIDE_TOP_K = 40;

/**
 * Answer a decision on one session. Every prompt is rendered whole, and the
 * tokens all prompts share are evaluated once. Each question then evaluates
 * only its own tail, reads the next-token probability of its labels among the
 * `DECIDE_TOP_K` most likely tokens, and is erased back to the shared start
 * for the next. A question none of whose labels is among them is read again
 * over the whole vocabulary, so its weights are never all 0 for want of
 * looking. ADR 01016, ADR 01019.
 */
export async function decideOn(
  session: WorkerSession,
  options: LlamaDecideOptions,
): Promise<LlamaDecideResult> {
  const sequence = sequenceOf(session);
  const rendered = options.prompts.map((p) => sequence.render(p, options.answerPrefix));
  const { results, inputTokens, reuse } = await onSharedStart(
    sequence,
    rendered,
    async (tail, i, rewind) => {
      const labels = (options.labels[i] ?? []).map((label) => {
        const ids = [...new Set(sequence.labelTokens(label))];
        if (ids.length === 0) {
          throw new Error(
            `The model has no single token for the answer label "${label}", so it cannot decide.`,
          );
        }
        return { label, ids };
      });
      const weigh = (next: Map<number, number>): Record<string, number> =>
        Object.fromEntries(
          labels.map(({ label, ids }) => [
            label,
            ids.reduce((sum, id) => sum + (next.get(id) ?? 0), 0),
          ]),
        );
      const weights = weigh(await sequence.probe(tail, DECIDE_TOP_K));
      if (labels.length === 0 || Object.values(weights).some((w) => w > 0)) return weights;
      await rewind();
      return weigh(await sequence.probe(tail));
    },
  );
  return {
    weights: results,
    usage: { inputTokens, outputTokens: 0 },
    ...(reuse ? { reuse } : {}),
  };
}

/**
 * Generate one JSON answer per prompt on one session, the shared start
 * evaluated once as for a decision. Each answer is generated under the
 * schema's grammar until the value is complete, the model ends it, or
 * `maxTokens` cuts it off. A failure is that prompt's alone: it is recorded,
 * and the next prompt starts from the shared start as usual. ADR 01018.
 */
export async function completeSharedOn(
  session: WorkerSession,
  options: LlamaSharedOptions,
): Promise<LlamaSharedResult> {
  const sequence = sequenceOf(session);
  const rendered = options.prompts.map((p) => sequence.render(p, ""));
  let outputTokens = 0;
  const { results, inputTokens, reuse } = await onSharedStart(
    sequence,
    rendered,
    async (tail) => {
      const generated: number[] = [];
      try {
        let text = "";
        let stopReason = "eogToken";
        for await (const token of sequence.generate(tail, options)) {
          generated.push(token);
          text = sequence.detokenize(generated);
          // The grammar still allows trailing whitespace; the value is done.
          if (isCompleteJson(text)) {
            stopReason = "complete";
            break;
          }
          if (options.maxTokens != null && generated.length >= options.maxTokens) {
            stopReason = "maxTokens";
            break;
          }
        }
        return { text, stopReason };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      } finally {
        outputTokens += generated.length;
      }
    },
  );
  return {
    outputs: results,
    usage: { inputTokens, outputTokens },
    ...(reuse ? { reuse } : {}),
  };
}

/**
 * Whether `text` is a whole JSON object or array, counting the opening brace
 * a grammar can leave off (ADR 01010), which the provider restores. Only text
 * that ends in a closer is tried: no proper prefix of an object parses.
 */
function isCompleteJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.endsWith("}") && !trimmed.endsWith("]")) return false;
  for (const candidate of [trimmed, `{${trimmed}`]) {
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      // Not this spelling.
    }
  }
  return false;
}

/** Tokens every prompt starts with, leaving each at least one of its own. */
function sharedPrefixLength(rendered: number[][]): number {
  const [first, ...rest] = rendered;
  if (!first) return 0;
  let length = Math.min(...rendered.map((tokens) => tokens.length)) - 1;
  for (const tokens of rest) {
    let i = 0;
    while (i < length && tokens[i] === first[i]) i++;
    length = i;
  }
  return Math.max(0, length);
}

export interface WorkerModel {
  readonly trainContextSize?: number;
  countTokens(text: string): number;
  createSession(systemPrompt: string, contextSize?: number): Promise<WorkerSession>;
  dispose(): Promise<void>;
}

export interface WorkerBackend {
  /** The backend that actually initialised. */
  readonly gpu: WorkerGpu;
  /** Memory available for weights, in bytes — see `getMemoryBudgetBytes`. */
  memoryBudget(): Promise<number>;
  loadModel(path: string): Promise<WorkerModel>;
}

/**
 * The context an unsized session gets — the same default `llama-cpp.ts` uses.
 * Restated rather than imported: this file may import only Node builtins.
 */
const DEFAULT_CONTEXT_SIZE = 8192;

type CreateWorkerBackend = (
  options: WorkerBackendOptions,
  hooks: WorkerBackendHooks,
) => Promise<WorkerBackend>;

/**
 * Open a backend from an imported module: node-llama-cpp itself, or — in the
 * test suite — a module exporting `createWorkerBackend`, which stands in for
 * the inference while the process, the IPC, and the crash stay real.
 */
export function openBackend(
  mod: unknown,
  options: WorkerBackendOptions,
  hooks: WorkerBackendHooks,
): Promise<WorkerBackend> {
  const custom = (mod as { createWorkerBackend?: CreateWorkerBackend })
    .createWorkerBackend;
  if (typeof custom === "function") return custom(options, hooks);
  return nodeLlamaCppBackend(mod as typeof import("node-llama-cpp"), options, hooks);
}

async function nodeLlamaCppBackend(
  mod: typeof import("node-llama-cpp"),
  options: WorkerBackendOptions,
  hooks: WorkerBackendHooks,
): Promise<WorkerBackend> {
  const { getLlama, getLlamaGpuTypes, LlamaChatSession, LlamaGrammarEvaluationState, TokenMeter } =
    mod;
  const { Gemma4ChatWrapper, QwenChatWrapper } = mod;

  /**
   * The chat template with thinking off. A decision reads the token right
   * after the answer prefix, so a model that opened a thought block there
   * would put its mass on the block, not on a letter. Qwen3 and 3.5 get the
   * empty `<think></think>` their template uses when thinking is disabled;
   * Gemma 4 gets its non-reasoning prompt. Other templates are used as is.
   */
  const withoutThinking = (wrapper: ChatWrapper): ChatWrapper => {
    if (wrapper instanceof QwenChatWrapper) {
      return new QwenChatWrapper({
        variation: wrapper.variation,
        keepOnlyLastThought: wrapper.keepOnlyLastThought,
        thoughts: "discourage",
      });
    }
    if (wrapper instanceof Gemma4ChatWrapper && wrapper.reasoning) {
      return new Gemma4ChatWrapper({
        reasoning: false,
        keepOnlyLastThought: wrapper.keepOnlyLastThought,
      });
    }
    return wrapper;
  };

  if (options.gpu === "auto" || typeof options.gpu === "object") {
    // getLlama picks the best supported backend not excluded; name that one
    // first. If getLlama settles on another, `llama.gpu` below is the truth.
    const exclude = typeof options.gpu === "object" ? options.gpu.exclude : [];
    const supported = await getLlamaGpuTypes("supported").catch(
      (): WorkerGpu[] => [],
    );
    hooks.trying(supported.find((g) => g !== false && !exclude.includes(g)) ?? false);
  } else {
    hooks.trying(options.gpu);
  }

  const llama = await getLlama({
    gpu: options.gpu,
    ...(options.build ? { build: options.build } : {}),
  });

  return {
    gpu: llama.gpu,

    async memoryBudget() {
      // Half of RAM is what a judge can reasonably claim on a shared machine;
      // a GPU's free VRAM is usable outright.
      const ramBudget = totalmem() / 2;
      try {
        const vram = await llama.getVramState();
        // The LARGER of the two, not VRAM in preference to RAM: llama.cpp
        // offloads the layers that fit onto the GPU and keeps the rest in
        // system RAM, so a small GPU beside plenty of RAM still runs a big
        // model. Sizing off VRAM alone would idle most of such a machine.
        return Math.max(vram.free, ramBudget);
      } catch {
        // CPU-only builds and probe failures are normal, never fatal.
        return ramBudget;
      }
    },

    async loadModel(path) {
      const model = await llama.loadModel({ modelPath: path });
      return {
        trainContextSize: model.trainContextSize,
        countTokens: (text) => model.tokenize(text).length,
        async createSession(systemPrompt, contextSize) {
          // Always an explicit size. Left out, node-llama-cpp sizes the context
          // to free memory, which is the bug ADR 01011 records.
          const context = await model.createContext({
            contextSize: contextSize ?? DEFAULT_CONTEXT_SIZE,
          });
          const sequence = context.getSequence();
          const session = new LlamaChatSession({
            contextSequence: sequence,
            systemPrompt,
          });
          const chat = withoutThinking(session.chatWrapper);
          const grammars = new WeakMap<object, LlamaGrammar>();
          return {
            contextSize: context.contextSize,
            sequence: {
              get needsCheckpoints() {
                return sequence.needsCheckpoints;
              },
              get nextTokenIndex() {
                return sequence.nextTokenIndex;
              },
              inputTokens: () => sequence.tokenMeter.usedInputTokens,
              render(user, answerPrefix) {
                const { contextText } = chat.generateContextState({
                  chatHistory: [
                    { type: "system", text: systemPrompt },
                    { type: "user", text: user },
                    { type: "model", response: answerPrefix ? [answerPrefix] : [] },
                  ],
                });
                return contextText.tokenize(model.tokenizer);
              },
              detokenize: (tokens) => model.detokenize(tokens as Token[]),
              async *generate(tokens, generateOptions) {
                // One grammar per schema object: every item of a request
                // shares it, and each gets an evaluation state of its own.
                let grammar = grammars.get(generateOptions.schema);
                if (!grammar) {
                  grammar = await llama.createGrammarForJsonSchema(
                    generateOptions.schema as Parameters<
                      typeof llama.createGrammarForJsonSchema
                    >[0],
                  );
                  grammars.set(generateOptions.schema, grammar);
                }
                yield* sequence.evaluate(tokens as Token[], {
                  temperature: generateOptions.temperature,
                  grammarEvaluationState: new LlamaGrammarEvaluationState({ model, grammar }),
                });
              },
              labelTokens: (label) =>
                [
                  model.tokenize(label, false, "trimLeadingSpace"),
                  model.tokenize(` ${label}`, false),
                ].flatMap((tokens) => (tokens.length === 1 ? tokens : [])),
              evaluate: (tokens) =>
                sequence.evaluateWithoutGeneratingNewTokens(tokens as Token[]),
              takeCheckpoint: () => sequence.takeCheckpoint(),
              erase: (start, end) => sequence.eraseContextTokenRanges([{ start, end }]),
              async probe(tokens, topK) {
                const last = tokens.length - 1;
                // Temperature 0 samples greedily, so its distribution is the
                // softmax over the whole vocabulary. With topK, temperature 1
                // keeps the softmax as it is, truncated to the topK most likely
                // tokens; topP 1 stops node-llama-cpp's default 0.95 from
                // cutting that short. Ratios between tokens are unchanged.
                const generateNext = {
                  probabilities: true,
                  ...(topK != null ? { options: { topK, topP: 1, minP: 0, temperature: 1 } } : {}),
                };
                const output = await sequence.controlledEvaluate(
                  (tokens as Token[]).map((token, i) =>
                    i === last ? [token, { generateNext }] : token,
                  ),
                );
                return output[last]?.next.probabilities ?? new Map<number, number>();
              },
            },
            async prompt(text, promptOptions) {
              const grammar = await llama.createGrammarForJsonSchema(
                promptOptions.schema as Parameters<
                  typeof llama.createGrammarForJsonSchema
                >[0],
              );
              const before = sequence.tokenMeter.getState();
              const result = await session.promptWithMeta(text, {
                grammar,
                temperature: promptOptions.temperature,
                budgets: { thoughtTokens: promptOptions.thoughtTokens },
                ...(promptOptions.maxTokens != null
                  ? { maxTokens: promptOptions.maxTokens }
                  : {}),
              });
              // promptWithMeta does not report usage; the sequence's meter does.
              const diff = TokenMeter.diff(sequence.tokenMeter, before);
              return {
                text: result.responseText,
                stopReason: result.stopReason,
                usage: {
                  inputTokens: diff.usedInputTokens,
                  outputTokens: diff.usedOutputTokens,
                },
              };
            },
            async dispose() {
              await context.dispose();
            },
          };
        },
        async dispose() {
          await model.dispose();
        },
      };
    },
  };
}

/** One request from the parent. Every one gets exactly one reply. */
export type WorkerRequest = { id: number } & (
  | { op: "init"; moduleUrl: string; options: WorkerBackendOptions }
  | { op: "memoryBudget" }
  | { op: "loadModel"; path: string }
  | { op: "countTokens"; modelId: number; text: string }
  | { op: "createSession"; modelId: number; systemPrompt: string; contextSize?: number }
  | { op: "prompt"; sessionId: number; text: string; options: LlamaPromptOptions }
  | { op: "decide"; sessionId: number; options: LlamaDecideOptions }
  | { op: "completeShared"; sessionId: number; options: LlamaSharedOptions }
  | { op: "disposeSession"; sessionId: number }
  | { op: "disposeModel"; modelId: number }
  | { op: "shutdown" }
);

export type WorkerMessage =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string } }
  | { event: "trying"; gpu: WorkerGpu };

/** Set by the parent at fork time, so importing this file never serves. */
export const WORKER_ENV_FLAG = "INFERENCE_LLAMA_WORKER";

function serve(): void {
  // Anything this worker spawns is not a worker.
  delete process.env[WORKER_ENV_FLAG];
  let backend: Promise<WorkerBackend> | undefined;
  const models = new Map<number, WorkerModel>();
  const sessions = new Map<number, WorkerSession>();
  let nextId = 1;

  const send = (message: WorkerMessage, then?: () => void): void => {
    try {
      process.send!(message, undefined, {}, () => then?.());
    } catch {
      // The parent is gone; `disconnect` below ends this process.
    }
  };

  const ready = (): Promise<WorkerBackend> => {
    if (!backend) throw new Error("The local-model worker was not initialised.");
    return backend;
  };
  const model = (id: number): WorkerModel => {
    const found = models.get(id);
    if (!found) throw new Error(`The local-model worker has no model ${id}.`);
    return found;
  };
  const session = (id: number): WorkerSession => {
    const found = sessions.get(id);
    if (!found) throw new Error(`The local-model worker has no session ${id}.`);
    return found;
  };

  async function dispatch(request: WorkerRequest): Promise<unknown> {
    switch (request.op) {
      case "init": {
        const mod: unknown = await import(request.moduleUrl);
        backend = openBackend(mod, request.options, {
          trying: (gpu) => send({ event: "trying", gpu }),
        });
        return { gpu: (await backend).gpu };
      }
      case "memoryBudget":
        return (await ready()).memoryBudget();
      case "loadModel": {
        const loaded = await (await ready()).loadModel(request.path);
        const modelId = nextId++;
        models.set(modelId, loaded);
        return { modelId, trainContextSize: loaded.trainContextSize };
      }
      case "countTokens":
        return model(request.modelId).countTokens(request.text);
      case "createSession": {
        const opened = await model(request.modelId).createSession(
          request.systemPrompt,
          request.contextSize,
        );
        const sessionId = nextId++;
        sessions.set(sessionId, opened);
        return { sessionId, contextSize: opened.contextSize };
      }
      case "prompt":
        return session(request.sessionId).prompt(request.text, request.options);
      case "decide":
        return decideOn(session(request.sessionId), request.options);
      case "completeShared":
        return completeSharedOn(session(request.sessionId), request.options);
      case "disposeSession": {
        const found = sessions.get(request.sessionId);
        sessions.delete(request.sessionId);
        await found?.dispose();
        return null;
      }
      case "disposeModel": {
        const found = models.get(request.modelId);
        models.delete(request.modelId);
        await found?.dispose();
        return null;
      }
      case "shutdown": {
        await Promise.allSettled([...sessions.values()].map((s) => s.dispose()));
        await Promise.allSettled([...models.values()].map((m) => m.dispose()));
        sessions.clear();
        models.clear();
        return null;
      }
    }
  }

  process.on("message", (request: WorkerRequest) => {
    void dispatch(request).then(
      (value) =>
        send({ id: request.id, ok: true, value: value ?? null }, () => {
          if (request.op === "shutdown") process.exit(0);
        }),
      (e: unknown) =>
        send({
          id: request.id,
          ok: false,
          error: {
            name: e instanceof Error ? e.name : "Error",
            message: e instanceof Error ? e.message : String(e),
          },
        }),
    );
  });

  // The parent exited, crashed, or was killed: nothing is left to answer.
  process.on("disconnect", () => process.exit(0));
}

if (process.send && process.env[WORKER_ENV_FLAG] === "1") serve();
