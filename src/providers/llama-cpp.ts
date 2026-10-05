/**
 * In-process local inference over GGUF weights via `node-llama-cpp`.
 *
 * Unlike every other provider here, this one owns weights: it downloads them
 * from Hugging Face on first use and holds gigabytes of RAM once loaded. Two
 * consequences shape the design.
 *
 * First, `node-llama-cpp` is a native module with prebuilt binaries per
 * platform and a CMake fallback. It is an OPTIONAL peer dependency reached
 * through a dynamic `import()`, so the four repos consuming this library pay
 * nothing — install cost or toolchain risk — unless they ask for local models.
 *
 * Second, everything real happens behind `LlamaRuntime`. Tests inject a fake
 * and never touch the network, the filesystem, or a GPU (the same seam as
 * `ExecFn` for the Claude CLI provider). The real runtime runs node-llama-cpp
 * in a worker process, so a native abort in llama.cpp costs a retry on another
 * backend rather than the consumer's process — see `llama-host.ts`, ADR 01012.
 */
import { InferenceError } from "../types.js";
import { buildCacheKey } from "../cache.js";
import { extractJson } from "./openai-compat.js";
import {
  aliasForTier,
  defaultLlamaModelsDirectory,
  isLlamaSelector,
  resolveLlamaModelRef,
} from "./llama-models.js";
import { createWorkerRuntime, isLlamaGpu, shutdownLlamaWorkers } from "./llama-host.js";
import { normalizeDecision, validateDecideRequest } from "./decide.js";
import type { DecideQuestion, DecideRequest, DecideResponse, DecisionProvider } from "./decide.js";
import type { LlamaGpu } from "./llama-host.js";
import type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  TokenUsage,
} from "./types.js";

export type { LlamaGpu } from "./llama-host.js";

export interface LlamaPromptOptions {
  /** JSON Schema converted to a GBNF grammar by the runtime. */
  schema: Record<string, unknown>;
  temperature: number;
  /** Thinking budget; 0 disables it. See the note in `completeJSON`. */
  thoughtTokens: number;
  maxTokens?: number;
}

export interface LlamaPromptResult {
  text: string;
  usage?: TokenUsage;
  /**
   * Why generation stopped. `"maxTokens"` means the output was cut off, so the
   * text is almost certainly truncated JSON — see the guard in `completeJSON`.
   */
  stopReason?: string;
}

/**
 * One decision request, as the provider hands it to a session: one user turn
 * per question, each opening the same way, so the runtime can evaluate the
 * shared start once. ADR 01016.
 */
export interface LlamaDecideOptions {
  /** One user turn per question. */
  prompts: string[];
  /** What the assistant's turn opens with; the token after it is the answer. */
  answerPrefix: string;
  /** Per prompt, the labels whose next-token probability is read. */
  labels: string[][];
}

/**
 * How a session got back to the shared start between questions:
 * `"erase"` removed the previous question from the context, `"checkpoint"`
 * restored a snapshot (hybrid and recurrent models, which cannot erase), and
 * `"reevaluate"` evaluated the shared start again.
 */
export type LlamaDecideReuse = "erase" | "checkpoint" | "reevaluate";

export interface LlamaDecideResult {
  /** Per prompt, each label's next-token probability. Need not sum to 1. */
  weights: Record<string, number>[];
  usage?: TokenUsage;
  /** Absent for a single question, which reuses nothing. */
  reuse?: LlamaDecideReuse;
}

export interface LlamaSession {
  prompt(text: string, options: LlamaPromptOptions): Promise<LlamaPromptResult>;
  /**
   * Next-token probabilities for each prompt's labels. Optional: a runtime
   * without it makes `decide()` reject. The real runtime has it.
   */
  decide?(options: LlamaDecideOptions): Promise<LlamaDecideResult>;
  dispose(): Promise<void>;
  /**
   * Tokens of context the runtime actually created. llama.cpp may round a
   * requested size up to a multiple of 256. Optional: a fake has no context.
   */
  readonly contextSize?: number;
}

export interface LlamaLoadedModel {
  /**
   * Open a single-turn session on a fresh context of `contextSize` tokens.
   * The provider always passes it, sized from the prompt it is about to send;
   * the real runtime treats an absent size as the 8192-token default.
   */
  createSession(systemPrompt: string, contextSize?: number): Promise<LlamaSession>;
  dispose(): Promise<void>;
  /**
   * The context length the model was trained on, the most a context can
   * usefully hold. Optional so a runtime written before it existed still
   * satisfies the seam; without it the provider assumes no ceiling.
   */
  readonly trainContextSize?: number;
  /**
   * Count `text` in this model's own tokens. Optional for the same reason;
   * without it the provider uses the default size and cannot check fit. May
   * be async: the real runtime's tokenizer lives in the worker process.
   */
  countTokens?(text: string): number | Promise<number>;
}

/**
 * The whole of `node-llama-cpp` that this provider uses. Kept this narrow so a
 * test fake is a few lines and so the real adapter is the only place that
 * knows the upstream API shape.
 */
export interface LlamaRuntime {
  /**
   * Resolve an `hf:` URI or path to a local file inside `directory`,
   * downloading if needed.
   */
  resolveModelFile(uri: string, directory: string): Promise<string>;
  loadModel(path: string): Promise<LlamaLoadedModel>;
  /** Memory available for weights, in bytes — VRAM if there is a GPU, else RAM. */
  getMemoryBudgetBytes(): Promise<number>;
}

export interface LlamaCppProviderOptions {
  /** Injected for tests; defaults to the real `node-llama-cpp` adapter. */
  runtime?: LlamaRuntime;
  /**
   * Thinking budget in tokens, default 0.
   *
   * Gemma 4 has a thinking mode, but a grammar constrains generation from
   * token 0 — so an unbudgeted model starts reasoning and gets cut off
   * mid-thought. Zero is the deterministic choice for judging; raise it if you
   * want reasoning before the JSON.
   */
  thoughtTokens?: number;
  maxTokens?: number;
  /**
   * A fixed context size in tokens, used for every call.
   *
   * Unset, the context is sized to the work: 8192 tokens, or more when the
   * prompt and its response reserve need it, up to the model's training
   * context. Either way, a prompt that does not fit fails with an
   * `InferenceError` rather than being truncated. ADR 01011.
   */
  contextSize?: number;
  /**
   * Where to download and look for weights. Defaults to this library's own
   * directory — see `defaultLlamaModelsDirectory`.
   */
  modelsDirectory?: string;
  /**
   * The llama.cpp backend: `"cuda"`, `"vulkan"`, `"metal"`, or `false` for the
   * CPU. Unset, `NODE_LLAMA_CPP_GPU` decides, and failing that `"auto"`.
   *
   * `"auto"` picks the best backend this machine has and, if it crashes the
   * local-model worker, retries on the next — CUDA, then Vulkan, then the CPU —
   * for the rest of the process. A named backend is never replaced: a crash on
   * it is an error. Ignored when `runtime` is injected. ADR 01012.
   */
  gpu?: LlamaGpu;
}

/**
 * Loaded weights, keyed by directory + URI.
 *
 * `runEnsemble` issues N sequential calls and a load costs seconds and
 * gigabytes, so this is process-wide rather than per-instance: two providers
 * naming the same model share one copy. Values are the in-flight promise so
 * concurrent first calls coalesce instead of loading twice. The directory is
 * part of the key because the same URI in two directories is two files.
 */
const loadedModels = new Map<string, Promise<LlamaLoadedModel>>();

/**
 * Free every loaded model.
 *
 * A standalone function rather than a `dispose()` on `InferenceProvider`:
 * adding one to the contract would make all five providers carry a lifecycle
 * only this one has. Short-lived processes can skip it.
 */
export async function disposeLlamaModels(): Promise<void> {
  const pending = [...loadedModels.values()];
  loadedModels.clear();
  await Promise.all(
    pending.map((p) => p.then((m) => m.dispose()).catch(() => undefined)),
  );
  // The weights lived in the local-model workers; end those processes too.
  await shutdownLlamaWorkers();
}

/**
 * The context a call gets when its prompt fits. node-llama-cpp's own default is
 * the largest context free memory allows, up to the training context: 131072
 * tokens and about 11 GB for granite-4.1-3b-q2 on CPU, for prompts of a few
 * thousand tokens. Bounded instead, so memory follows the work. ADR 01011.
 */
const DEFAULT_CONTEXT_SIZE = 8192;

/**
 * Room for what the token count of the two prompts does not see: the chat
 * template's role markers and separators. The grammar itself takes no context;
 * the schema restated in the system prompt does, and is counted there.
 */
const CHAT_TEMPLATE_OVERHEAD_TOKENS = 512;

/** Room for the response when `maxTokens` does not bound it. */
const DEFAULT_RESPONSE_RESERVE_TOKENS = 2048;

/**
 * A decision's response: the answer prefix the runtime adds to the assistant
 * turn, and the one letter read after it.
 */
const DECIDE_ANSWER_TOKENS = 8;

/**
 * Room `stateLimit()` keeps for what the provider adds around a consumer's
 * state and question: headings, option letters, the closing instruction.
 * About 30 tokens plus 3 per option, so 26 options fit.
 */
const DECIDE_FRAMING_TOKENS = 128;

/** Options are lettered, so a question has at most this many. */
const DECIDE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The fixed instruction every decision runs under. */
const DECIDE_SYSTEM_PROMPT =
  "You answer multiple-choice questions about the state the user shows you. " +
  "Read the state and the question, then reply with the letter of the one option that fits best.";

const DECIDE_ANSWER_PREFIX = "Answer:";

export class LlamaCppProvider implements DecisionProvider {
  private readonly uri: string;
  private readonly runtime: LlamaRuntime;
  private readonly thoughtTokens: number;
  private readonly maxTokens: number | undefined;
  private readonly contextSize: number | undefined;
  private readonly modelsDirectory: string;
  /**
   * Loaded-model key: the same URI in two directories is two different files.
   * Built with `buildCacheKey` so its parts are length-prefixed — a plain join
   * would let two different (directory, uri) pairs collide and hand a provider
   * back the wrong weights.
   */
  private readonly cacheKey: string;

  constructor(
    private readonly model: string,
    options: LlamaCppProviderOptions = {},
  ) {
    if (isLlamaSelector(model)) {
      throw new InferenceError(
        `llama-cpp model "${model}" is a selector. Constructing a provider ` +
          `directly needs a concrete model (e.g. "${aliasForTier("balanced")}") — use ` +
          `makeProviderAsync to resolve a selector against this machine.`,
      );
    }
    if (
      options.contextSize !== undefined &&
      !(Number.isInteger(options.contextSize) && options.contextSize > 0)
    ) {
      throw new InferenceError(
        `llamaCpp.contextSize must be a positive integer number of tokens, ` +
          `got ${String(options.contextSize)}.`,
      );
    }
    if (options.gpu !== undefined && !isLlamaGpu(options.gpu)) {
      throw new InferenceError(
        `llamaCpp.gpu must be "auto", "cuda", "vulkan", "metal" or false, ` +
          `got ${JSON.stringify(options.gpu) ?? String(options.gpu)}.`,
      );
    }
    this.contextSize = options.contextSize;
    this.uri = resolveLlamaModelRef(model);
    this.runtime =
      options.runtime ??
      defaultLlamaRuntime(options.gpu !== undefined ? { gpu: options.gpu } : {});
    this.thoughtTokens = options.thoughtTokens ?? 0;
    this.maxTokens = options.maxTokens;
    this.modelsDirectory =
      options.modelsDirectory ?? defaultLlamaModelsDirectory();
    this.cacheKey = buildCacheKey([this.modelsDirectory, this.uri]);
  }

  provider(): string {
    return "llama-cpp";
  }

  modelName(): string {
    return this.model;
  }

  async completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResponse> {
    const model = await this.load();
    const systemPrompt = systemPromptFor(req);
    // A fresh session per call: the contract is single-shot, and reusing one
    // would leak the previous run's turns into this one's context. Its context
    // is created here, where the prompt is known, so it is sized to the prompt.
    const plan = await this.contextFor(model, systemPrompt, [req.user]);
    const session = await model.createSession(systemPrompt, plan.contextSize);
    // With no maxTokens, the response is capped at the room the context has
    // left. Uncapped, a long answer fills the context and node-llama-cpp shifts
    // the prompt out of it to keep going; capped, it stops at maxTokens and the
    // guard below reports it. ADR 01011.
    const contextSize = session.contextSize ?? plan.contextSize;
    const implicitMaxTokens =
      this.maxTokens == null && plan.promptTokens != null
        ? contextSize - plan.promptTokens
        : undefined;
    const maxTokens = this.maxTokens ?? implicitMaxTokens;
    try {
      const result = await session.prompt(req.user, {
        schema: req.schema,
        temperature: req.temperature,
        thoughtTokens: this.thoughtTokens,
        ...(maxTokens != null ? { maxTokens } : {}),
      });
      // A run cut off at the token or context limit leaves truncated JSON.
      // Without this it surfaces as "failed schema validation" — or worse,
      // extractJson's brace-slicing fallback salvages a wrong-but-parseable
      // object — and the retry burns another full local inference to fail the
      // same way. Same guard as the Anthropic provider's max_tokens check.
      if (result.stopReason === "maxTokens" && implicitMaxTokens != null) {
        throw new Error(
          `llama-cpp generation filled the ${contextSize}-token context before ` +
            `completing the JSON — raise llamaCpp.contextSize, or set ` +
            `llamaCpp.maxTokens to bound the response.`,
        );
      }
      if (result.stopReason === "maxTokens") {
        throw new Error(
          `llama-cpp generation hit the token limit before completing the JSON` +
            `${this.maxTokens != null ? ` (maxTokens: ${this.maxTokens})` : ""}` +
            ` — raise llamaCpp.maxTokens, or shorten the prompt if the context is full.`,
        );
      }
      return { json: extractJson(restoreOpenBrace(result.text)), usage: result.usage };
    } finally {
      await session.dispose().catch(() => undefined);
    }
  }

  /**
   * Probabilities over each question's options, read from the model's
   * next-token distribution after a lettered prompt. One session serves every
   * question, so the state is evaluated once. ADR 01016.
   */
  async decide(req: DecideRequest): Promise<DecideResponse> {
    validateDecideRequest(req);
    const questions = Object.entries(req.questions);
    for (const [id, question] of questions) {
      const count = Object.keys(question.criteria).length;
      if (count > DECIDE_LETTERS.length) {
        throw new InferenceError(
          `llama-cpp decide() question "${id}" has ${count} criteria; it letters ` +
            `options A to Z, so ${DECIDE_LETTERS.length} at most.`,
        );
      }
    }
    const state =
      typeof req.state === "string" ? req.state : JSON.stringify(req.state, null, 2);
    const prompts = questions.map(([, question]) => decisionPrompt(state, question));

    const model = await this.load();
    const plan = await this.contextFor(
      model,
      DECIDE_SYSTEM_PROMPT,
      prompts,
      DECIDE_ANSWER_TOKENS,
    );
    const session = await model.createSession(DECIDE_SYSTEM_PROMPT, plan.contextSize);
    try {
      if (!session.decide) {
        throw new InferenceError(
          "This llama-cpp runtime's sessions have no decide(), so the provider " +
            "cannot answer decisions.",
        );
      }
      const result = await session.decide({
        prompts,
        answerPrefix: DECIDE_ANSWER_PREFIX,
        labels: questions.map(([, question]) => lettersFor(question)),
      });
      const answers = Object.fromEntries(
        questions.map(([id, question], i) => {
          const options = Object.keys(question.criteria);
          const weights = result.weights[i] ?? {};
          const byOption = Object.fromEntries(
            options.map((option, j) => [option, weights[DECIDE_LETTERS[j]!] ?? 0]),
          );
          return [id, normalizeDecision(options, byOption)];
        }),
      );
      return { answers, ...(result.usage ? { usage: result.usage } : {}) };
    } finally {
      await session.dispose().catch(() => undefined);
    }
  }

  /**
   * Tokens a decision accepts for its state plus its longest question: the
   * most `decide` lets a context hold, less the fixed instruction, the chat
   * template's overhead, the answer, and the provider's own framing. The same
   * arithmetic `contextFor` refuses by, so a state within it is never refused.
   */
  async stateLimit(): Promise<number> {
    const model = await this.load();
    const ceiling = this.contextSize ?? model.trainContextSize ?? DEFAULT_CONTEXT_SIZE;
    const system = model.countTokens ? await model.countTokens(DECIDE_SYSTEM_PROMPT) : 0;
    return Math.max(
      0,
      ceiling -
        system -
        CHAT_TEMPLATE_OVERHEAD_TOKENS -
        DECIDE_ANSWER_TOKENS -
        DECIDE_FRAMING_TOKENS,
    );
  }

  /**
   * The context this call needs: both prompts in the model's own tokens, the
   * chat template's overhead, and room for the response. A prompt that does not
   * fit is refused here, before anything is created. llama.cpp would otherwise
   * shift the overflow out of the context and answer a prompt nobody sent.
   */
  private async contextFor(
    model: LlamaLoadedModel,
    systemPrompt: string,
    /** The user prompts the session holds, one at a time; the longest counts. */
    users: string[],
    /** A fixed response size, for a call `maxTokens` does not bound. */
    responseTokens?: number,
  ): Promise<{ contextSize: number; promptTokens?: number }> {
    const ceiling = model.trainContextSize;
    const fallback =
      this.contextSize ??
      (ceiling != null
        ? Math.min(DEFAULT_CONTEXT_SIZE, ceiling)
        : DEFAULT_CONTEXT_SIZE);
    if (!model.countTokens) return { contextSize: fallback };

    const countTokens = model.countTokens.bind(model);
    const [system = 0, ...counts] = await Promise.all(
      [systemPrompt, ...users].map((text) => countTokens(text)),
    );
    const prompt = Math.max(0, ...counts);
    // A decision reads one token, so maxTokens and thinking do not bound it.
    const bounded = responseTokens == null && this.maxTokens != null;
    const response =
      responseTokens ??
      (this.maxTokens ?? DEFAULT_RESPONSE_RESERVE_TOKENS) + this.thoughtTokens;
    const promptTokens = system + prompt + CHAT_TEMPLATE_OVERHEAD_TOKENS;
    const needed = promptTokens + response;
    const counted =
      `Counted: system ${system} + user ${prompt} + ` +
      `${CHAT_TEMPLATE_OVERHEAD_TOKENS} chat-template overhead + ` +
      `${response} for the response.`;

    if (this.contextSize != null) {
      if (needed > this.contextSize) {
        throw new InferenceError(
          `llama-cpp prompt needs ${needed} tokens of context, more than ` +
            `llamaCpp.contextSize (${this.contextSize}). ${counted} Raise ` +
            `llamaCpp.contextSize, ${
              responseTokens != null ? "" : `${bounded ? "lower" : "set"} llamaCpp.maxTokens, `
            }or leave contextSize unset so the context is sized to the prompt.`,
        );
      }
      return { contextSize: this.contextSize, promptTokens };
    }
    if (ceiling != null && needed > ceiling) {
      throw new InferenceError(
        `llama-cpp prompt needs ${needed} tokens of context, more than this ` +
          `model's training context of ${ceiling} tokens. ${counted} Shorten the ` +
          `prompt${bounded ? ", or lower llamaCpp.maxTokens" : ""}.`,
      );
    }
    return { contextSize: Math.max(fallback, needed), promptTokens };
  }

  private load(): Promise<LlamaLoadedModel> {
    const existing = loadedModels.get(this.cacheKey);
    if (existing) return existing;
    const pending = (async () => {
      const path = await this.runtime.resolveModelFile(
        this.uri,
        this.modelsDirectory,
      );
      return this.runtime.loadModel(path);
    })();
    // Drop a failed load so the next call retries — a download interrupted by
    // a flaky network must not poison the model for the rest of the process.
    // Only evict our OWN entry: a dispose plus a re-load between the failure
    // and this handler would otherwise orphan the newer model, leaking it.
    const guarded = pending.catch((e: unknown) => {
      if (loadedModels.get(this.cacheKey) === guarded) {
        loadedModels.delete(this.cacheKey);
      }
      throw e;
    });
    loadedModels.set(this.cacheKey, guarded);
    return guarded;
  }
}

/**
 * One question's user turn. The state comes first, so every question of a
 * request opens with the same text and the runtime evaluates it once.
 */
function decisionPrompt(state: string, question: DecideQuestion): string {
  const options = Object.entries(question.criteria)
    .map(([id, meaning], i) => `${DECIDE_LETTERS[i]!}. ${meaning || id}`)
    .join("\n");
  return (
    `# State\n\n${state}\n\n# Question\n\n${question.instructions}\n\n${options}\n\n` +
    `Reply with the letter of one option.`
  );
}

function lettersFor(question: DecideQuestion): string[] {
  return [...DECIDE_LETTERS.slice(0, Object.keys(question.criteria).length)];
}

/**
 * The grammar constrains the SHAPE of the output, but `node-llama-cpp` never
 * shows the schema to the model — so `description` fields, which is where
 * consumers put their domain instructions (ADR 01001), would be invisible.
 * Restating the schema is the same fix the Claude CLI provider and the
 * OpenAI json_object fallback already use.
 */
function systemPromptFor(req: CompleteJSONRequest): string {
  return `${req.system}\n\nRespond with ONLY a JSON object conforming to this JSON Schema:\n${JSON.stringify(
    req.schema,
  )}`;
}

/**
 * Put back the `{` that grammar-constrained generation leaves off.
 *
 * node-llama-cpp builds a GBNF grammar from the request schema and the grammar
 * accounts for the opening brace itself, so `result.text` can begin at the
 * first key — `"match": "pass", ...}` rather than `{"match": ...}`. Observed
 * from Qwen3.5-4B-UD-Q4_K_XL on node-llama-cpp 3.20.0.
 *
 * Left alone, that reaches `extractJson`, fails `JSON.parse`, and hits the
 * first-`{`-to-last-`}` fallback — which is at best an opaque error and at
 * worst a wrong object. When the payload holds an array the fallback latches
 * onto the first *element's* brace and produces `{...},{...}]}`, surfacing as
 * `Unexpected non-whitespace character after JSON at position 100`. A caller
 * cannot act on that.
 *
 * The repair is deliberately narrow: only when the text does not already parse
 * on its own, and only when adding the brace makes it parse. A response that
 * was already well-formed is returned untouched, so this cannot turn a working
 * reply into `{{...}`, and text that is broken some other way is handed to
 * `extractJson` exactly as before.
 */
export function restoreOpenBrace(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return text;
  try {
    JSON.parse(trimmed);
    return text;
  } catch {
    /* Not valid on its own — try the brace below. */
  }
  const repaired = `{${trimmed}`;
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return text;
  }
}

/**
 * The real runtime: node-llama-cpp in a worker process, falling back from a
 * GPU backend that crashes it. Lazy — constructing a provider for a
 * fully-cached run starts no process and loads no native binary.
 */
export function defaultLlamaRuntime(options: { gpu?: LlamaGpu } = {}): LlamaRuntime {
  return createWorkerRuntime(options);
}
