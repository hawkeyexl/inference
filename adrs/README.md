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
