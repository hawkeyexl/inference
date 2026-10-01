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
 * `ExecFn` for the Claude CLI provider).
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
import { importNodeLlamaCpp, isModuleNotFound } from "./llama-install.js";
import type {
  CompleteJSONRequest,
  CompleteJSONResponse,
  InferenceProvider,
  TokenUsage,
} from "./types.js";

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

export interface LlamaSession {
  prompt(text: string, options: LlamaPromptOptions): Promise<LlamaPromptResult>;
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
   * without it the provider uses the default size and cannot check fit.
   */
  countTokens?(text: string): number;
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

export class LlamaCppProvider implements InferenceProvider {
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
    this.contextSize = options.contextSize;
    this.uri = resolveLlamaModelRef(model);
    this.runtime = options.runtime ?? defaultLlamaRuntime();
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
    const plan = this.contextFor(model, systemPrompt, req.user);
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
   * The context this call needs: both prompts in the model's own tokens, the
   * chat template's overhead, and room for the response. A prompt that does not
   * fit is refused here, before anything is created. llama.cpp would otherwise
   * shift the overflow out of the context and answer a prompt nobody sent.
   */
  private contextFor(
    model: LlamaLoadedModel,
    systemPrompt: string,
    user: string,
  ): { contextSize: number; promptTokens?: number } {
    const ceiling = model.trainContextSize;
    const fallback =
      this.contextSize ??
      (ceiling != null
        ? Math.min(DEFAULT_CONTEXT_SIZE, ceiling)
        : DEFAULT_CONTEXT_SIZE);
    if (!model.countTokens) return { contextSize: fallback };

    const system = model.countTokens(systemPrompt);
    const prompt = model.countTokens(user);
    const response =
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
            `llamaCpp.contextSize, ${this.maxTokens != null ? "lower" : "set"} ` +
            `llamaCpp.maxTokens, or leave contextSize unset so the context is sized to the prompt.`,
        );
      }
      return { contextSize: this.contextSize, promptTokens };
    }
    if (ceiling != null && needed > ceiling) {
      throw new InferenceError(
        `llama-cpp prompt needs ${needed} tokens of context, more than this ` +
          `model's training context of ${ceiling} tokens. ${counted} Shorten the ` +
          `prompt${this.maxTokens != null ? ", or lower llamaCpp.maxTokens" : ""}.`,
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

/** Cached so repeated provider construction imports the native module once. */
let runtimePromise: Promise<LlamaRuntime> | undefined;

/**
 * Lazy adapter over the real `node-llama-cpp`. Every method defers to the
 * dynamic import, so constructing a provider for a fully-cached run never
 * loads the native binary.
 */
export function defaultLlamaRuntime(): LlamaRuntime {
  const real = (): Promise<LlamaRuntime> =>
    // Drop a failed init so the next call retries. A GPU that failed to
    // initialise, or a binary still being extracted by a concurrent install,
    // must not poison the runtime for the rest of the process — the same rule
    // `load()` applies to weights.
    (runtimePromise ??= loadNodeLlamaCpp().catch((e: unknown) => {
      runtimePromise = undefined;
      throw e;
    }));
  return {
    resolveModelFile: (uri, directory) =>
      real().then((r) => r.resolveModelFile(uri, directory)),
    loadModel: (path) => real().then((r) => r.loadModel(path)),
    getMemoryBudgetBytes: () => real().then((r) => r.getMemoryBudgetBytes()),
  };
}

async function loadNodeLlamaCpp(): Promise<LlamaRuntime> {
  let mod: typeof import("node-llama-cpp");
  try {
    mod = await import("node-llama-cpp");
  } catch (e) {
    // A package that resolved and then failed to load — ABI mismatch, missing
    // system library, unsupported Node — is not a missing package. Installing
    // over it would fetch the same broken thing again and replace a precise
    // error with a download.
    if (!isModuleNotFound(e)) {
      throw new InferenceError(
        `node-llama-cpp is installed but failed to load (${
          e instanceof Error ? e.message : String(e)
        }). This is the copy resolved from your own node_modules, so ` +
          `reinstalling it here will not help — check the Node version and the ` +
          `platform build.`,
      );
    }
    // Genuinely absent, so fall back to the library's own prefix — installing
    // it there if needed. npm does not install optional peers, and detection
    // ends at this provider precisely because it needs no credentials, so
    // refusing here would strand the one machine `auto` exists to serve.
    // Resetting `runtimePromise` is the caller's job — see `defaultLlamaRuntime`.
    mod = (await importNodeLlamaCpp()) as typeof import("node-llama-cpp");
  }

  const { getLlama, resolveModelFile, LlamaChatSession, TokenMeter } = mod;
  const llama = await getLlama();

  return {
    // `directory` is this library's own, not node-llama-cpp's global default —
    // owning it is what makes `clearLlamaModels` safe.
    resolveModelFile: (uri, directory) => resolveModelFile(uri, { directory }),

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
          return {
            contextSize: context.contextSize,
            async prompt(text, options) {
              const grammar = await llama.createGrammarForJsonSchema(
                options.schema as Parameters<
                  typeof llama.createGrammarForJsonSchema
                >[0],
              );
              const before = sequence.tokenMeter.getState();
              const result = await session.promptWithMeta(text, {
                grammar,
                temperature: options.temperature,
                budgets: { thoughtTokens: options.thoughtTokens },
                ...(options.maxTokens != null
                  ? { maxTokens: options.maxTokens }
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

    async getMemoryBudgetBytes() {
      const { totalmem } = await import("node:os");
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
  };
}
