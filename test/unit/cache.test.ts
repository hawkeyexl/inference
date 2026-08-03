import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonCache, buildCacheKey, sha256 } from "../../src/index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "inference-cache-"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildCacheKey", () => {
  it("is stable for the same parts and differs for any change", () => {
    const a = buildCacheKey(["anthropic", "claude-sonnet-4-5", "v1"]);
    const b = buildCacheKey(["anthropic", "claude-sonnet-4-5", "v1"]);
    const c = buildCacheKey(["anthropic", "claude-sonnet-4-5", "v2"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("does not collide across part boundaries", () => {
    expect(buildCacheKey(["ab", "c"])).not.toBe(buildCacheKey(["a", "bc"]));
  });

  it("does not collide when a part contains the separator", () => {
    // A plain join makes ["a|b","c"] and ["a","b|c"] the same string, so two
    // different key compositions would share one cached result.
    expect(buildCacheKey(["a|b", "c"])).not.toBe(buildCacheKey(["a", "b|c"]));
  });

  it("exposes sha256 for pre-hashing large parts", () => {
    expect(sha256("hello")).toHaveLength(64);
  });
});

describe("JsonCache", () => {
  it("round-trips a value", () => {
    const cache = new JsonCache<{ n: number }>(tempDir());
    cache.set("k", { n: 1 });
    expect(cache.get("k")).toEqual({ n: 1 });
  });

  it("misses on an unknown key", () => {
    expect(new JsonCache(tempDir()).get("nope")).toBeUndefined();
  });

  it("treats a corrupt entry as a miss rather than throwing", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "k.json"), "{not json");
    expect(new JsonCache(dir).get("k")).toBeUndefined();
  });

  it("reads and writes nothing when disabled", () => {
    const dir = tempDir();
    const cache = new JsonCache<{ n: number }>(dir, false);
    cache.set("k", { n: 1 });
    expect(cache.get("k")).toBeUndefined();
  });

  it("warns once and keeps going when writes fail", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A path under a file (not a directory) cannot be created.
    const dir = tempDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const cache = new JsonCache<{ n: number }>(join(blocker, "cache"));

    expect(() => cache.set("a", { n: 1 })).not.toThrow();
    expect(() => cache.set("b", { n: 2 })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses the supplied label in the warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = tempDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    new JsonCache(join(blocker, "cache"), true, "docevals").set("a", 1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/^docevals:/);
  });

  it("writes human-readable JSON so a cached result can be inspected", () => {
    const dir = tempDir();
    new JsonCache<{ n: number }>(dir).set("k", { n: 1 });
    expect(readFileSync(join(dir, "k.json"), "utf8")).toContain("\n");
  });
});
