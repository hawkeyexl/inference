/**
 * Content-addressed JSON cache for inference results, so a cached run replays
 * identically instead of re-billing a nondeterministic call.
 *
 * Key composition stays with the caller: each consumer has a different notion
 * of what should invalidate an entry (page body, prompt version, ensemble
 * size, requested fields). `buildCacheKey` just hashes the parts you name.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hash an ordered list of key parts into a cache key. Long parts (page bodies,
 * rendered traces) should be pre-hashed with `sha256` by the caller so the
 * joined string stays small.
 */
export function buildCacheKey(parts: string[]): string {
  return sha256(parts.join("|"));
}

export class JsonCache<T> {
  /** Cache-write failures warn once per process, not once per entry. */
  private warned = false;

  constructor(
    private readonly dir: string,
    private readonly enabled: boolean = true,
    /** Prefix for the one-time write-failure warning. */
    private readonly label: string = "inference",
  ) {}

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const path = join(this.dir, `${key}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return undefined; // Corrupt cache entry — treat as a miss.
    }
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    // The cache is an optimization: a write failure (read-only workspace, full
    // disk, long path) must never abort a run whose inference already
    // succeeded and was already paid for.
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        join(this.dir, `${key}.json`),
        JSON.stringify(value, null, 2),
      );
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `${this.label}: could not write the cache at ${this.dir} (${
            e instanceof Error ? e.message : String(e)
          }). Continuing without caching.`,
        );
      }
    }
  }
}
