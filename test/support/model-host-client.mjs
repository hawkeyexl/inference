/**
 * A second, separate client process: one call through a running model host,
 * printed as JSON. Run with `--import ts-hooks.mjs` and
 * `--experimental-transform-types`. MODEL_HOST_CLIENT holds the provider's
 * model and options.
 */
const { LlamaCppProvider } = await import("../../src/index.js");

const { model, options, user } = JSON.parse(process.env.MODEL_HOST_CLIENT ?? "{}");
const result = await new LlamaCppProvider(model, options).completeJSON({
  system: "You grade claims.",
  user,
  schema: { type: "object" },
  temperature: 0,
});
process.stdout.write(JSON.stringify(result.json));
