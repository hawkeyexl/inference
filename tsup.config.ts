import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Forked by the local-model runtime, found beside index.js. ADR 01012.
    "llama-worker": "src/providers/llama-worker.ts",
  },
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  dts: true,
  sourcemap: true,
  // No `banner` shebang here: this package is a library, not a CLI.
});
