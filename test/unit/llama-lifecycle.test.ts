/**
 * The model lifecycle helpers: `ensureModel`, `modelState`, `fits`.
 *
 * Only the download itself is faked (a `LlamaRuntime` whose `resolveModelFile`
 * writes a file where the real one would fetch it from Hugging Face). Lock
 * files, `.ipull` partials, the models directory and process liveness are all
 * real, in temp directories.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InferenceError,
  LLAMA_MODELS,
  ensureModel,
  fits,
  modelState,
  tierForBudget,
} from "../../src/index.js";
import { MEMORY_HEADROOM } from "../../src/providers/llama-models.js";
import type { LlamaRuntime } from "../../src/index.js";

const ALIAS = "granite-4.1-3b-q2";
const ENTRY = LLAMA_MODELS[ALIAS]!;
const BLOB = ENTRY.uri.split("/").pop()!;
/** node-llama-cpp prefixes a download with `hf_<user>_`. */
const ON_DISK = `hf_unsloth_${BLOB}`;
const LOCK = `.download-${BLOB}.lock`;
const FILE_BYTES = 64;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inference-lifecycle-"));
});

interface FakeRuntime extends LlamaRuntime {
  downloads: string[];
  loads: number;
}

/** Stands in for the Hugging Face download and nothing else. */
function fakeRuntime(over: { budget?: number; downloadMs?: number } = {}): FakeRuntime {
  const runtime: FakeRuntime = {
    downloads: [],
    loads: 0,
    async resolveModelFile(uri, directory) {
      runtime.downloads.push(uri);
      await new Promise((r) => setTimeout(r, over.downloadMs ?? 0));
      const path = join(directory, `hf_unsloth_${uri.split("/").pop()}`);
      writeFileSync(path, Buffer.alloc(FILE_BYTES));
      return path;
    },
    loadModel() {
      runtime.loads += 1;
      return Promise.reject(new Error("a lifecycle helper must never load weights"));
    },
    getMemoryBudgetBytes: () => Promise.resolve(over.budget ?? 8_000_000_000),
  };
  return runtime;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid;
}

function ago(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

describe("modelState", () => {
  it("is missing for an empty directory and for one that does not exist", async () => {
    expect(await modelState(ALIAS, { modelsDirectory: dir })).toBe("missing");
    expect(await modelState(ALIAS, { modelsDirectory: join(dir, "absent") })).toBe("missing");
  });

  it("is ready once the blob is on disk", async () => {
    writeFileSync(join(dir, ON_DISK), Buffer.alloc(FILE_BYTES));
    expect(await modelState(ALIAS, { modelsDirectory: dir })).toBe("ready");
  });

  it("is downloading while a live process holds the download lock", async () => {
    writeFileSync(join(dir, LOCK), String(process.pid));
    expect(await modelState(ALIAS, { modelsDirectory: dir })).toBe("downloading");
  });

  it("is missing when the lock's holder is dead, however fresh the lock", async () => {
    writeFileSync(join(dir, LOCK), String(deadPid()));
    expect(await modelState(ALIAS, { modelsDirectory: dir })).toBe("missing");
  });

  it("is downloading for a fresh .ipull partial and missing for an abandoned one", async () => {
    const partial = join(dir, `${ON_DISK}.ipull`);
    writeFileSync(partial, Buffer.alloc(FILE_BYTES));
    expect(await modelState(ALIAS, { modelsDirectory: dir })).toBe("downloading");
    ago(partial, 60 * 60 * 1000);
    expect(await modelState(ALIAS, { modelsDirectory: dir })).toBe("missing");
  });

  it("ignores a partial that belongs to a different model", async () => {
    writeFileSync(join(dir, "hf_unsloth_something-else.gguf.ipull"), Buffer.alloc(8));
    expect(await modelState(ALIAS, { modelsDirectory: dir })).toBe("missing");
  });

  it("never downloads and never loads", async () => {
    const runtime = fakeRuntime();
    await modelState(ALIAS, { modelsDirectory: dir, runtime });
    expect(runtime.downloads).toEqual([]);
    expect(runtime.loads).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("resolves a tier keyword to its catalog model", async () => {
    writeFileSync(join(dir, ON_DISK), Buffer.alloc(FILE_BYTES));
    expect(await modelState("fast", { modelsDirectory: dir })).toBe("ready");
  });

  it("resolves auto against the memory the runtime reports", async () => {
    const quality = LLAMA_MODELS["qwen3.5-9b"]!;
    writeFileSync(
      join(dir, `hf_unsloth_${quality.uri.split("/").pop()}`),
      Buffer.alloc(FILE_BYTES),
    );
    const huge = fakeRuntime({ budget: 64_000_000_000 });
    expect(await modelState("auto", { modelsDirectory: dir, runtime: huge })).toBe("ready");
    const tiny = fakeRuntime({ budget: 1_000_000_000 });
    expect(await modelState("auto", { modelsDirectory: dir, runtime: tiny })).toBe("missing");
  });

  it("is ready for a local .gguf path that exists", async () => {
    const local = join(dir, "mine.gguf");
    writeFileSync(local, Buffer.alloc(FILE_BYTES));
    expect(await modelState(local, { modelsDirectory: join(dir, "elsewhere") })).toBe("ready");
  });

  it("rejects an unknown model name", async () => {
    await expect(modelState("not-a-model", { modelsDirectory: dir })).rejects.toThrow(
      InferenceError,
    );
  });
});

describe("ensureModel", () => {
  it("downloads once, reports the bytes, and never loads", async () => {
    const runtime = fakeRuntime();
    const result = await ensureModel(ALIAS, { modelsDirectory: dir, runtime });
    expect(result).toEqual({ state: "downloaded", bytes: FILE_BYTES });
    expect(runtime.downloads).toEqual([ENTRY.uri]);
    expect(runtime.loads).toBe(0);
    expect(statSync(join(dir, ON_DISK)).size).toBe(FILE_BYTES);
    expect(await modelState(ALIAS, { modelsDirectory: dir })).toBe("ready");
  });

  it("releases the lock after the download", async () => {
    await ensureModel(ALIAS, { modelsDirectory: dir, runtime: fakeRuntime() });
    expect(existsSync(join(dir, LOCK))).toBe(false);
  });

  it("releases the lock when the download fails, and the next call retries", async () => {
    const failing = fakeRuntime();
    failing.resolveModelFile = () => Promise.reject(new Error("network down"));
    await expect(
      ensureModel(ALIAS, { modelsDirectory: dir, runtime: failing }),
    ).rejects.toThrow("network down");
    expect(existsSync(join(dir, LOCK))).toBe(false);
    const ok = fakeRuntime();
    expect((await ensureModel(ALIAS, { modelsDirectory: dir, runtime: ok })).state).toBe(
      "downloaded",
    );
  });

  it("is ready, without touching the runtime, when the file is already there", async () => {
    writeFileSync(join(dir, ON_DISK), Buffer.alloc(FILE_BYTES));
    const runtime = fakeRuntime();
    const result = await ensureModel(ALIAS, { modelsDirectory: dir, runtime });
    expect(result).toEqual({ state: "ready", bytes: FILE_BYTES });
    expect(runtime.downloads).toEqual([]);
  });

  it("sums the parts of a split model", async () => {
    const stem = ON_DISK.replace(/\.gguf$/, "");
    writeFileSync(join(dir, `${stem}-00001-of-00002.gguf`), Buffer.alloc(10));
    writeFileSync(join(dir, `${stem}-00002-of-00002.gguf`), Buffer.alloc(5));
    const result = await ensureModel(ALIAS, { modelsDirectory: dir, runtime: fakeRuntime() });
    expect(result).toEqual({ state: "ready", bytes: 15 });
  });

  it("creates the models directory when it does not exist", async () => {
    const nested = join(dir, "a", "b");
    await ensureModel(ALIAS, { modelsDirectory: nested, runtime: fakeRuntime() });
    expect(existsSync(join(nested, ON_DISK))).toBe(true);
  });

  it("two callers in one process download once; the second returns ready", async () => {
    const runtime = fakeRuntime({ downloadMs: 50 });
    const [a, b] = await Promise.all([
      ensureModel(ALIAS, { modelsDirectory: dir, runtime }),
      ensureModel(ALIAS, { modelsDirectory: dir, runtime }),
    ]);
    expect(runtime.downloads).toHaveLength(1);
    expect([a.state, b.state].sort()).toEqual(["downloaded", "ready"]);
  });

  it("returns ready when another process holds the lock and the file appears", async () => {
    // A lock held by a live pid — this test process stands in for the other one.
    writeFileSync(join(dir, LOCK), String(process.pid));
    const runtime = fakeRuntime();
    const pending = ensureModel(ALIAS, { modelsDirectory: dir, runtime });
    setTimeout(() => writeFileSync(join(dir, ON_DISK), Buffer.alloc(FILE_BYTES)), 100);
    expect(await pending).toEqual({ state: "ready", bytes: FILE_BYTES });
    expect(runtime.downloads).toEqual([]);
    // Not ours, so not removed.
    expect(existsSync(join(dir, LOCK))).toBe(true);
  });

  it("reclaims a lock whose holder died, instead of waiting for it", async () => {
    writeFileSync(join(dir, LOCK), String(deadPid()));
    const runtime = fakeRuntime();
    expect((await ensureModel(ALIAS, { modelsDirectory: dir, runtime })).state).toBe(
      "downloaded",
    );
  });

  it("refuses before downloading when the runtime is absent and installing is refused", async () => {
    const moduleNotFound = Object.assign(new Error("nope"), { code: "ERR_MODULE_NOT_FOUND" });
    const error = await ensureModel(ALIAS, {
      modelsDirectory: dir,
      install: {
        directory: join(dir, "runtime"),
        env: { INFERENCE_NO_AUTO_INSTALL: "1" },
        probeImport: () => Promise.reject(moduleNotFound),
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toContain("INFERENCE_NO_AUTO_INSTALL");
    expect(readdirSync(dir).filter((f) => f.endsWith(".gguf") || f.endsWith(".ipull"))).toEqual(
      [],
    );
  });

  it("installs the runtime through the existing path before downloading", async () => {
    const moduleNotFound = Object.assign(new Error("nope"), { code: "ERR_MODULE_NOT_FOUND" });
    const exec = vi.fn(() =>
      Promise.resolve({ code: 1, stdout: "", stderr: "boom", timedOut: false }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      ensureModel(ALIAS, {
        modelsDirectory: dir,
        install: {
          directory: join(dir, "runtime"),
          env: {},
          exec,
          probeImport: () => Promise.reject(moduleNotFound),
        },
      }),
    ).rejects.toThrow(/Installing node-llama-cpp/);
    expect(exec).toHaveBeenCalledOnce();
  });
});

describe("fits", () => {
  it("compares the catalog size times the shared headroom with the runtime's budget", async () => {
    const need = ENTRY.sizeBytes * MEMORY_HEADROOM;
    const roomy = await fits(ALIAS, {
      modelsDirectory: dir,
      runtime: fakeRuntime({ budget: need + 1 }),
    });
    expect(roomy).toEqual({ fits: true, needBytes: need, freeBytes: need + 1 });
    const tight = await fits(ALIAS, {
      modelsDirectory: dir,
      runtime: fakeRuntime({ budget: need - 1 }),
    });
    expect(tight).toEqual({ fits: false, needBytes: need, freeBytes: need - 1 });
  });

  it("agrees with tierForBudget on the same number", async () => {
    // One headroom, shared: the budget that is exactly enough for the fast
    // tier's weights is the budget at which tierForBudget stops choosing less.
    const need = ENTRY.sizeBytes * MEMORY_HEADROOM;
    expect(tierForBudget(need)).toBe("fast");
    const quality = LLAMA_MODELS["qwen3.5-9b"]!;
    const qualityNeed = quality.sizeBytes * MEMORY_HEADROOM;
    expect(tierForBudget(qualityNeed)).toBe("quality");
    const result = await fits("qwen3.5-9b", {
      modelsDirectory: dir,
      runtime: fakeRuntime({ budget: qualityNeed }),
    });
    expect(result.fits).toBe(true);
    expect(tierForBudget(qualityNeed - 1)).not.toBe("quality");
    expect(
      (await fits("qwen3.5-9b", { modelsDirectory: dir, runtime: fakeRuntime({ budget: qualityNeed - 1 }) }))
        .fits,
    ).toBe(false);
  });

  it("sizes an uncatalogued model from its downloaded file", async () => {
    const uri = "hf:someone/repo/custom-model.gguf";
    writeFileSync(join(dir, "hf_someone_custom-model.gguf"), Buffer.alloc(1000));
    const result = await fits(uri, { modelsDirectory: dir, runtime: fakeRuntime({ budget: 10_000 }) });
    expect(result).toEqual({ fits: true, needBytes: 1000 * MEMORY_HEADROOM, freeBytes: 10_000 });
  });

  it("sizes a local .gguf path from the file itself", async () => {
    const local = join(dir, "mine.gguf");
    writeFileSync(local, Buffer.alloc(1000));
    const result = await fits(local, { modelsDirectory: join(dir, "elsewhere"), runtime: fakeRuntime({ budget: 100 }) });
    expect(result).toEqual({ fits: false, needBytes: 1000 * MEMORY_HEADROOM, freeBytes: 100 });
  });

  it("throws a documented InferenceError for an uncatalogued model that is not downloaded", async () => {
    const error = await fits("hf:someone/repo/custom-model.gguf", {
      modelsDirectory: dir,
      runtime: fakeRuntime(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect((error as Error).message).toContain("Cannot size llama-cpp model");
  });

  it("does not download or load to answer", async () => {
    const runtime = fakeRuntime();
    await fits(ALIAS, { modelsDirectory: dir, runtime });
    expect(runtime.downloads).toEqual([]);
    expect(runtime.loads).toBe(0);
    mkdirSync(join(dir, "x"));
  });
});
