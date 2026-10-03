/**
 * Lets a plain `node` process import this repo's TypeScript sources.
 *
 * Node 24 strips types itself, but `src/` imports its siblings by their
 * built `.js` names. This maps a relative `.js` that does not exist to the
 * `.ts` beside it. Used with `--experimental-transform-types` (the sources use
 * parameter properties) by tests that need a real parent process — one that
 * exits, or is killed, on its own terms — rather than the vitest worker.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (/^\.{1,2}\//.test(specifier) && specifier.endsWith(".js")) {
        return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
      }
      throw e;
    }
  },
});
