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
});
