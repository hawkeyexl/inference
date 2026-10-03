import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("source hygiene", () => {
  it("contains no NUL bytes", () => {
    // A stray NUL makes git treat the file as BINARY: its diff shows
    // "Binary files differ" instead of any content, so the file becomes
    // unreviewable in a PR and `git blame` stops working on it. It is also
    // invisible in an editor, which is how one reached `llama-cpp.ts` once.
    const offenders = sourceFiles("src")
      .concat(sourceFiles("test"))
      .filter((path) => readFileSync(path).includes(0));
    expect(offenders).toEqual([]);
  });

  it("keeps the local-model worker runnable by Node without a build", () => {
    // The worker is forked from `src/` under vitest, where Node strips its
    // types but cannot map a sibling's `.js` import to its `.ts`. So it may
    // import only Node builtins at runtime; types are erased and harmless.
    const source = readFileSync(join("src", "providers", "llama-worker.ts"), "utf8");
    const runtimeImports = [
      ...source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    expect(runtimeImports.filter((s) => !s!.startsWith("node:"))).toEqual([]);
  });
});
