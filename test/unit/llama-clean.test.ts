import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LLAMA_MODELS,
  clearLlamaModels,
  defaultLlamaModelsDirectory,
} from "../../src/index.js";

/** Name node-llama-cpp gives a downloaded blob: `hf_<user>_<filename>`. */
function downloadedName(alias: string): string {
  const uri = LLAMA_MODELS[alias]!.uri;
  const [, user] = /^hf:([^/]+)\//.exec(uri)!;
  return `hf_${user}_${uri.split("/").pop()}`;
}

let dir: string;

function write(name: string, bytes: number): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inference-clean-"));
});

describe("clearLlamaModels", () => {
  it("removes catalog models and reports what it freed", async () => {
    write(downloadedName("gemma-4-e2b"), 2048);
    write(downloadedName("gemma-4-12b"), 1024);

    const result = await clearLlamaModels({ directory: dir });

    expect(result.freedBytes).toBe(3072);
    expect(result.files).toHaveLength(2);
    expect(result.directory).toBe(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("defaults to this library's own directory, not the shared one", () => {
    // Owning the directory is what makes clearing it safe: node-llama-cpp's
    // global ~/.node-llama-cpp/models is shared with its CLI and other tools.
    // The env override is cleared first — otherwise a developer who legitimately
    // points the library at a shared volume gets an unrelated red test.
    const saved = process.env["INFERENCE_MODELS_DIR"];
    delete process.env["INFERENCE_MODELS_DIR"];
    try {
      expect(defaultLlamaModelsDirectory()).not.toContain(".node-llama-cpp");
      expect(defaultLlamaModelsDirectory()).toContain("hawkeyexl-inference");
    } finally {
      if (saved !== undefined) process.env["INFERENCE_MODELS_DIR"] = saved;
    }
  });

  it("honours the INFERENCE_MODELS_DIR override", () => {
    const saved = process.env["INFERENCE_MODELS_DIR"];
    process.env["INFERENCE_MODELS_DIR"] = dir;
    try {
      expect(defaultLlamaModelsDirectory()).toBe(dir);
    } finally {
      if (saved === undefined) delete process.env["INFERENCE_MODELS_DIR"];
      else process.env["INFERENCE_MODELS_DIR"] = saved;
    }
  });

  it("removes interrupted partial downloads of catalog models", async () => {
    write(`${downloadedName("gemma-4-e4b")}.ipull`, 1500);

    const result = await clearLlamaModels({ directory: dir });

    expect(result.freedBytes).toBe(1500);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes every part of a split model, not just the first", async () => {
    const stem = downloadedName("gemma-4-12b").replace(/\.gguf$/, "");
    write(`${stem}-00001-of-00003.gguf`, 100);
    write(`${stem}-00002-of-00003.gguf`, 100);
    write(`${stem}-00003-of-00003.gguf`, 100);

    const result = await clearLlamaModels({ directory: dir });

    expect(result.files).toHaveLength(3);
    expect(result.freedBytes).toBe(300);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("clears only the named models when given a list", async () => {
    write(downloadedName("gemma-4-e2b"), 2048);
    write(downloadedName("gemma-4-12b"), 1024);

    const result = await clearLlamaModels({
      directory: dir,
      models: ["gemma-4-e2b"],
    });

    expect(result.freedBytes).toBe(2048);
    expect(readdirSync(dir)).toEqual([downloadedName("gemma-4-12b")]);
  });

  it("accepts a hugging face URI in the model list", async () => {
    write(downloadedName("gemma-4-e4b"), 777);
    const result = await clearLlamaModels({
      directory: dir,
      models: [LLAMA_MODELS["gemma-4-e4b"]!.uri],
    });
    expect(result.freedBytes).toBe(777);
  });

  it("accepts a hugging face URI carrying a #branch fragment", async () => {
    // node-llama-cpp accepts `hf:user/repo/file.gguf#branch`. Leaving the
    // fragment on the filename makes the match silently find nothing.
    write(downloadedName("gemma-4-e4b"), 640);
    const result = await clearLlamaModels({
      directory: dir,
      models: [`${LLAMA_MODELS["gemma-4-e4b"]!.uri}#main`],
    });
    expect(result.freedBytes).toBe(640);
  });

  it("reports without deleting under dryRun", async () => {
    const path = write(downloadedName("gemma-4-e2b"), 2048);

    const result = await clearLlamaModels({ directory: dir, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.freedBytes).toBe(2048);
    expect(result.files[0]?.path).toBe(path);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("never touches non-model files", async () => {
    write("notes.txt", 10);
    write("config.json", 10);
    write(downloadedName("gemma-4-e2b"), 2048);

    await clearLlamaModels({ directory: dir });

    expect(readdirSync(dir).sort()).toEqual(["config.json", "notes.txt"]);
  });

  it("does not recurse into subdirectories", async () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(
      join(dir, "nested", downloadedName("gemma-4-e2b")),
      Buffer.alloc(99),
    );

    const result = await clearLlamaModels({ directory: dir });

    expect(result.files).toHaveLength(0);
    expect(readdirSync(join(dir, "nested"))).toHaveLength(1);
  });

  it("clears models it did not download, since the directory is its own", async () => {
    // No allow-listing needed once the directory belongs to this library.
    write("some-hand-placed-model.gguf", 4096);
    const result = await clearLlamaModels({ directory: dir });
    expect(result.freedBytes).toBe(4096);
  });

  it("returns an empty result for a directory that does not exist", async () => {
    const result = await clearLlamaModels({ directory: join(dir, "absent") });
    expect(result.files).toEqual([]);
    expect(result.freedBytes).toBe(0);
  });

  it("rejects an unknown model name rather than silently clearing nothing", async () => {
    await expect(
      clearLlamaModels({ directory: dir, models: ["gemma-9-nope"] }),
    ).rejects.toThrow(/Unknown llama-cpp model/);
  });
});
