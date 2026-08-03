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

function hasKey(spec: ProviderSpec, provider: "anthropic" | "openai"): boolean {
  const name = spec.apiKeyEnv ?? DEFAULT_KEY_ENV[provider]!;
  // An empty string is not a key; treating it as one produces a 401 later.
  return (process.env[name] ?? "") !== "";
}

/**
 * Memoised: spawning a process costs ~100ms and detection may run per provider
 * construction. Environment probes stay unmemoised — they are free, and a
 * consumer may legitimately set a key part-way through a process.
 */
let cliProbe: Promise<boolean> | undefined;

/** Test seam: forget the memoised Claude CLI probe. */
export function resetLlamaCliProbe(): void {
  cliProbe = undefined;
}

function probeClaudeCli(spec: ProviderSpec): Promise<boolean> {
  const exec = spec.exec ?? realExec;
  const command = spec.command ?? "claude";
  return (cliProbe ??= exec([command, "--version"], { timeoutMs: 10_000 })
    .then((r) => r.code === 0 && !r.timedOut && r.spawnError == null)
    .catch(() => false));
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
      return hasKey(spec, "anthropic")
        ? { available: true }
        : {
            available: false,
            reason: `${spec.apiKeyEnv ?? "ANTHROPIC_API_KEY"} is not set`,
          };
    case "openai":
      // A local OpenAI-compatible server needs no key — same rule the
      // OpenAICompatProvider constructor applies.
      return hasKey(spec, "openai") || spec.baseUrl
        ? { available: true }
        : {
            available: false,
            reason: `${spec.apiKeyEnv ?? "OPENAI_API_KEY"} is not set and no baseUrl was given`,
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
  const probes = await Promise.all(
    DETECTION_ORDER.map((name) => probe(name, spec)),
  );
  const index = probes.findIndex((p) => p.available);
  if (index >= 0) {
    const chosen = DETECTION_ORDER[index]!;
    warnSelected(chosen);
    return chosen;
  }
  const lines = DETECTION_ORDER.map(
    (name, i) => `  ${name.padEnd(10)} — ${probes[i]!.reason}`,
  ).join("\n");
  throw new InferenceError(
    `No inference provider is available. Tried:\n${lines}\n` +
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
function warnSelected(provider: ProviderName): void {
  if (warnedSelection) return;
  warnedSelection = true;
  console.warn(
    `inference: no provider specified — auto-selected "${provider}". ` +
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
