import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LLAMA_MODELS, isModelDownloaded } from "../../src/index.js";

const E4B = LLAMA_MODELS["gemma-4-e4b"]!.uri;

/** Name node-llama-cpp gives a downloaded blob: `hf_<user>_<filename>`. */
function downloadedName(uri: string): string {
  const [, user] = /^hf:([^/]+)\//.exec(uri)!;
  return `hf_${user}_${uri.split("/").pop()}`;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inference-present-"));
});

describe("isModelDownloaded", () => {
  it("is false for an empty directory", () => {
    expect(isModelDownloaded(E4B, dir)).toBe(false);
  });

  it("is false for a directory that does not exist", () => {
    expect(isModelDownloaded(E4B, join(dir, "absent"))).toBe(false);
  });

  it("is true once the blob is present", () => {
    writeFileSync(join(dir, downloadedName(E4B)), Buffer.alloc(8));
    expect(isModelDownloaded(E4B, dir)).toBe(true);
  });

  it("accepts a curated alias as well as a URI", () => {
    writeFileSync(join(dir, downloadedName(E4B)), Buffer.alloc(8));
    expect(isModelDownloaded("gemma-4-e4b", dir)).toBe(true);
  });

  it("is not fooled by a different model in the same directory", () => {
    const other = LLAMA_MODELS["gemma-4-12b"]!.uri;
    writeFileSync(join(dir, downloadedName(other)), Buffer.alloc(8));
    expect(isModelDownloaded(E4B, dir)).toBe(false);
  });

  it("treats an interrupted .ipull partial as not downloaded", () => {
    // A partial cannot be loaded, so reporting it as present would skip the
    // download warning and then stall on a download anyway.
    writeFileSync(join(dir, `${downloadedName(E4B)}.ipull`), Buffer.alloc(8));
    expect(isModelDownloaded(E4B, dir)).toBe(false);
  });

  it("recognises a split model by its parts", () => {
    const stem = downloadedName(E4B).replace(/\.gguf$/, "");
    writeFileSync(join(dir, `${stem}-00001-of-00002.gguf`), Buffer.alloc(8));
    expect(isModelDownloaded(E4B, dir)).toBe(true);
  });

  it("does not look inside subdirectories", () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", downloadedName(E4B)), Buffer.alloc(8));
    expect(isModelDownloaded(E4B, dir)).toBe(false);
  });
});
