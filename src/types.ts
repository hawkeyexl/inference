/**
 * Shared error type. Consumers catch this to distinguish an inference-layer
 * operational failure (missing API key, unknown provider) from their own
 * domain errors, and typically map it to their own exit code.
 */
export class InferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceError";
  }
}
