# Architecture Decision Records

Behavior decisions in `@hawkeyexl/inference` ship with an ADR in
[MADR 4.0.0](https://adr.github.io/madr/) format — see the "Architecture Decision Records" section
of [CLAUDE.md](../CLAUDE.md) for when one is required and what it must contain.

- Filename: `NNNNN-kebab-case-title.md`, 5-digit zero-padded.
- Numbering starts at `01000`. The range `00001`–`00999` is reserved for backfilling pre-existing
  decisions inherited from the source projects (docevals ADR 01001's ensemble semantics, for
  instance) if and when that becomes useful.

| ADR | Title |
|---|---|
| [01000](01000-library-owned-provider-spec.md) | A library-owned `ProviderSpec`, not consumer config objects |
| [01001](01001-single-entry-point-and-canonical-verdict-schema.md) | One entry point, and a canonical verdict schema with an override seam |
| [01002](01002-best-of-merge-of-three-forks.md) | Best-of merge of three drifted forks |
| [01003](01003-in-process-local-models-via-node-llama-cpp.md) | In-process local models via node-llama-cpp, behind an async selector |
| [01004](01004-provider-auto-detection.md) | Detect an available provider when none is specified, ending at the local model |
| [01005](01005-docset-strategy-and-executable-examples.md) | A CUJ-first documentation set, with samples that CI executes |
| [01006](01006-documenting-failure-and-orchestration.md) | Document failure and orchestration, and gate both against the source |
| [01007](01007-harden-two-operational-failure-paths.md) | Harden two operational failure paths: non-JSON CLI output, and an unsupported Node |
| [01008](01008-auto-install-the-local-runtime.md) | Auto-install the local runtime into a library-owned prefix, and refuse a model without a provider |
| [01009](01009-retier-the-local-model-catalog-by-measurement.md) | Choose the local model tiers by measuring this library's own task, not by published benchmarks |
| [01010](01010-restore-the-grammar-omitted-open-brace.md) | Restore the opening brace grammar-constrained generation omits, so the local provider works at all |
| [01011](01011-size-the-local-context-to-the-prompt.md) | Size the local model's context to the prompt, not to free memory, with a `contextSize` override |
| [01012](01012-isolate-local-inference-in-a-worker-process.md) | Run local inference in a worker process, and fall back from a GPU backend that crashes it |
| [01013](01013-decisions-as-an-optional-provider-capability.md) | Add decisions as an optional provider capability, in Jev's request shape |
| [01014](01014-model-lifecycle-helpers-for-the-local-provider.md) | Add `ensureModel`, `modelState` and `fits` so a consumer can prepare a local model without loading it |
| [01015](01015-the-jev-decision-provider.md) | Add `jev`, a hosted decision provider, that is never auto-detected and never answers `completeJSON` |
| [01016](01016-decide-on-local-models-from-letter-probabilities.md) | Decide on local models from the next-token probabilities of option letters, evaluating the shared state once |
| [01017](01017-keep-local-models-loaded-in-a-model-host.md) | Keep local models loaded across processes in an opt-in model host |
