/**
 * Which providers can this machine actually use, and which should it pick?
 *
 * Every probe goes through a seam that already exists — environment variables,
 * `ExecFn`, `LlamaRuntime` — so the whole matrix is exercisable offline with no
 * network, no subprocess, and no weights.
 *
 * Detection is async because two of the four probes are: running the Claude CLI
 * and loading the optional `node-llama-cpp` binding. That is why only
 * `resolveProviderIdentityAsync`/`makeProviderAsync` can resolve an `auto`
 * provider, and the synchronous twins throw instead of guessing.
 */
import { InferenceError } from "../types.js";
import { realExec } from "../exec.js";
import { defaultLlamaRuntime } from "./llama-cpp.js";
import type { ProviderName, ProviderSpec } from "./index.js";

/**
 * Priority order. `mock` is deliberately absent: it answers `{ json: {} }`
 * unless scripted, which would sail through as a non-error result — the exact
 * opposite of the "an errored run is recorded, never coerced" invariant the
 * consuming eval tools depend on. It must always be asked for by name.
 */
export const DETECTION_ORDER: readonly ProviderName[] = [
  "anthropic",
  "openai",
  "claude-cli",
  "llama-cpp",
];

const DEFAULT_KEY_ENV: Partial<Record<ProviderName, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

interface Probe {
  available: boolean;
  /** Why not, phrased as advice — this is what the aggregate error prints. */
  reason?: string;
}

/**
 * Probes the provider's DEFAULT key variable, deliberately ignoring
 * `spec.apiKeyEnv`.
 *
 * `apiKeyEnv` is one field shared by both API providers, and detection only
 * runs when no provider was named — so a custom name cannot say which provider
 * it belongs to. Honouring it here made a single custom variable satisfy both
 * probes, and anthropic then won on priority: a spec carrying an OpenAI key
 * under a custom name selected `anthropic` and 401'd at call time.
 *
 * A custom `apiKeyEnv` still applies in full once a provider is named — it just
 * cannot be what chooses one.
 */
function hasKey(provider: "anthropic" | "openai"): boolean {
  // An empty string is not a key; treating it as one produces a 401 later.
  return (process.env[DEFAULT_KEY_ENV[provider]!] ?? "") !== "";
}

/**
 * Memoised **per command**: spawning a process costs ~150ms and detection may
 * run on every provider construction, but a spec naming a different executable
 * is a different question — memoising on one key would make a fallback to an
 * absolute path silently inherit the bare command's failure.
 *
 * Environment probes stay unmemoised: they are free, and a consumer may
 * legitimately set a key part-way through a process.
 */
const cliProbes = new Map<string, Promise<boolean>>();

/** Test seam: forget the memoised Claude CLI probes. */
export function resetClaudeCliProbe(): void {
  cliProbes.clear();
}

function probeClaudeCli(spec: ProviderSpec): Promise<boolean> {
  const exec = spec.exec ?? realExec;
  const command = spec.command ?? "claude";
  const cached = cliProbes.get(command);
  if (cached) return cached;
  const probing = exec([command, "--version"], { timeoutMs: 10_000 })
    .then((r) => r.code === 0 && !r.timedOut && r.spawnError == null)
    .catch(() => false);
  cliProbes.set(command, probing);
  return probing;
}

function probeLlamaCpp(spec: ProviderSpec): Promise<Probe> {
  const runtime =
    spec.llamaRuntime ?? spec.llamaCpp?.runtime ?? defaultLlamaRuntime();
  // The same call the `auto` MODEL selector makes, so choosing llama-cpp here
  // costs nothing extra: it is loaded either way.
  return runtime.getMemoryBudgetBytes().then(
    () => ({ available: true }),
    (e: unknown) => ({
      available: false,
      reason:
        e instanceof Error && /node-llama-cpp/.test(e.message)
          ? "node-llama-cpp is not installed (npm i node-llama-cpp)"
          : `node-llama-cpp could not start (${
              e instanceof Error ? e.message : String(e)
            })`,
    }),
  );
}

async function probe(
  provider: ProviderName,
  spec: ProviderSpec,
): Promise<Probe> {
  switch (provider) {
    case "anthropic":
      return hasKey("anthropic")
        ? { available: true }
        : {
            available: false,
            reason: `ANTHROPIC_API_KEY is not set`,
          };
    case "openai":
      // A local OpenAI-compatible server needs no key — same rule the
      // OpenAICompatProvider constructor applies.
      return hasKey("openai") || spec.baseUrl
        ? { available: true }
        : {
            available: false,
            reason: `OPENAI_API_KEY is not set and no baseUrl was given`,
          };
    case "claude-cli":
      return (await probeClaudeCli(spec))
        ? { available: true }
        : {
            available: false,
            reason: `could not run \`${spec.command ?? "claude"}\` (is the Claude CLI installed?)`,
          };
    case "llama-cpp":
      return probeLlamaCpp(spec);
    default:
      return { available: false, reason: "not auto-selectable" };
  }
}

/**
 * Every provider this machine could use right now, in priority order.
 *
 * Useful for showing a picker or explaining a fallback; `detectProvider` is
 * the same sweep with the first hit returned.
 */
export async function availableProviders(
  spec: ProviderSpec = {},
): Promise<ProviderName[]> {
  const probes = await Promise.all(
    DETECTION_ORDER.map((name) => probe(name, spec)),
  );
  return DETECTION_ORDER.filter((_, i) => probes[i]!.available);
}

/**
 * The highest-priority provider this machine can use.
 *
 * Throws an `InferenceError` naming every provider and why each was
 * unavailable — far more actionable than the `Unknown provider "undefined"`
 * this replaces.
 */
export async function detectProvider(
  spec: ProviderSpec = {},
): Promise<ProviderName> {
  // Sequential, not Promise.all: the probes get dramatically more expensive
  // down the list, and the cheapest usually wins. Reading an environment
  // variable costs microseconds, spawning the Claude CLI ~150ms, and loading
  // the node-llama-cpp binding ~850ms — the last of which also initialises the
  // llama backend and allocates GPU context. Probing eagerly would pay all of
  // that on every construction just to pick `anthropic` off an env var, and
  // would touch the GPU for a provider that is never used.
  const reasons: string[] = [];
  for (const name of DETECTION_ORDER) {
    const result = await probe(name, spec);
    if (result.available) {
      warnSelected(name, spec.provider === "auto");
      return name;
    }
    reasons.push(`  ${name.padEnd(10)} — ${result.reason}`);
  }
  throw new InferenceError(
    `No inference provider is available. Tried:\n${reasons.join("\n")}\n` +
      `Pass an explicit \`provider\`, set one of the keys above, or install node-llama-cpp.`,
  );
}

let warnedSelection = false;
let warnedDownload = false;

/** Test seam: reset the once-per-process auto-detection warnings. */
export function resetProviderDetectionWarning(): void {
  warnedSelection = false;
  warnedDownload = false;
}

/**
 * These are eval tools: a run whose provider silently changed because an
 * environment variable moved is a run whose verdicts and cache are no longer
 * comparable to the last one. Say which provider was picked, once.
 */
function warnSelected(provider: ProviderName, wasExplicitAuto: boolean): void {
  if (warnedSelection) return;
  warnedSelection = true;
  // `provider: "auto"` IS a specification — saying otherwise sends someone
  // hunting their config for a field they did set.
  const because = wasExplicitAuto ? `provider "auto"` : "no provider specified";
  console.warn(
    `inference: ${because} — auto-selected "${provider}". ` +
      `Pass an explicit \`provider\` to pin it.`,
  );
}

/**
 * Falling back to a local model can mean pulling gigabytes. Say so before it
 * starts, not after a CI job has already stalled on it.
 */
export function warnPendingDownload(model: string, sizeBytes: number): void {
  if (warnedDownload) return;
  warnedDownload = true;
  console.warn(
    `inference: "${model}" is not downloaded yet — the first run will fetch ` +
      `~${(sizeBytes / 1e9).toFixed(2)} GB. Pre-fetch it, or pass an explicit ` +
      `\`provider\` to avoid the local model entirely.`,
  );
}
