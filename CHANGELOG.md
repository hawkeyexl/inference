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
