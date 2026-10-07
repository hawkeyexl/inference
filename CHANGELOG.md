# [0.5.0-decide-and-host.7](https://github.com/hawkeyexl/inference/compare/v0.5.0-decide-and-host.6...v0.5.0-decide-and-host.7) (2026-10-06)


### Bug Fixes

* **openai:** cap every request with openai.maxTokens ([4b15e31](https://github.com/hawkeyexl/inference/commit/4b15e315308ad02257becd2f1ab530d7f35d597e))

# [0.5.0-decide-and-host.6](https://github.com/hawkeyexl/inference/compare/v0.5.0-decide-and-host.5...v0.5.0-decide-and-host.6) (2026-10-06)


### Bug Fixes

* **openai:** keep a required property non-null in a strict schema ([6468f44](https://github.com/hawkeyexl/inference/commit/6468f4494914f23b00c4b2b4d1492fbe1fcb58af))

# [0.5.0-decide-and-host.5](https://github.com/hawkeyexl/inference/compare/v0.5.0-decide-and-host.4...v0.5.0-decide-and-host.5) (2026-10-06)


### Features

* **llama-cpp:** answer many items with schema-valid JSON over one shared prefix ([4dc487e](https://github.com/hawkeyexl/inference/commit/4dc487eed966237e8aa8d65736cfd6123027af9f))

# [0.5.0-decide-and-host.4](https://github.com/hawkeyexl/inference/compare/v0.5.0-decide-and-host.3...v0.5.0-decide-and-host.4) (2026-10-05)


### Features

* **llama-cpp:** keep local models loaded across processes in a model host ([fdb83e8](https://github.com/hawkeyexl/inference/commit/fdb83e8c447fc3757e0634006dad7ab6080bae95))

# [0.5.0-decide-and-host.3](https://github.com/hawkeyexl/inference/compare/v0.5.0-decide-and-host.2...v0.5.0-decide-and-host.3) (2026-10-05)


### Features

* **llama-cpp:** answer decisions from option-letter probabilities ([dcd9d59](https://github.com/hawkeyexl/inference/commit/dcd9d594aa22d298730ca5ce03ceffe59c654373))

# [0.5.0-decide-and-host.2](https://github.com/hawkeyexl/inference/compare/v0.5.0-decide-and-host.1...v0.5.0-decide-and-host.2) (2026-10-05)


### Bug Fixes

* **jev:** drop the price table entry ([7486e9d](https://github.com/hawkeyexl/inference/commit/7486e9d7878325cda838d45ca346f1b9982bb664))


### Features

* **jev:** add the jev provider, a hosted decision provider for TypeSafe's Jev ([cab2bcc](https://github.com/hawkeyexl/inference/commit/cab2bccf1db376dbef5b88437314f9242fff342f))
* **llama-cpp:** add ensureModel, modelState and fits to prepare a local model without loading it ([b7a46ee](https://github.com/hawkeyexl/inference/commit/b7a46ee75ea1ae2410c41eb40539baccef9da550))

# [0.5.0-decide-and-host.1](https://github.com/hawkeyexl/inference/compare/v0.4.0...v0.5.0-decide-and-host.1) (2026-10-05)


### Features

* **decide:** add decisions as an optional provider capability ([4163e99](https://github.com/hawkeyexl/inference/commit/4163e990253292b6ed994337572715c9908c3689))

# [0.4.0](https://github.com/hawkeyexl/inference/compare/v0.3.2...v0.4.0) (2026-10-03)


### Features

* **llama-cpp:** run local inference in a worker and fall back from a crashing GPU backend ([#13](https://github.com/hawkeyexl/inference/issues/13)) ([415f34d](https://github.com/hawkeyexl/inference/commit/415f34d14f42cff95bb7963369c078d952e79a89))

## [0.3.2](https://github.com/hawkeyexl/inference/compare/v0.3.1...v0.3.2) (2026-10-01)


### Bug Fixes

* **llama-cpp:** size the context to the prompt instead of to free memory ([#10](https://github.com/hawkeyexl/inference/issues/10)) ([4a31499](https://github.com/hawkeyexl/inference/commit/4a31499acc68bee3711182248aa6639cd25a0537))
