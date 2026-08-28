---
status: accepted
---

# Plugins are the source of truth

The `.esp`/`.esm`/`.esl` binary files on disk are the authoritative source of record data. The
plugin is what the game reads, what every other tool in the ecosystem understands, and what the
user ships — there is no drift problem, no synchronization problem, and no format translation
cost. For a tracked mod, the source tree is a lossless, gate-verified *editable form* of the same
truth, never a second truth ([ADR-0042](0042-plugin-is-the-source-of-truth-lossless-source.md)).

## Alternatives rejected

- **YAML via Spriggit as the working format** — three representations of the data (binary, YAML,
  index), a hard runtime dependency on a .NET CLI tool, 3–5× disk amplification, and an unclear
  session lifetime. Rejected twice: here, and again in ADR-0042 for a new reason — Spriggit's
  format is lossy by design.
- **The index (SQLite/DuckDB) as source of truth** — a database that can be deleted and rebuilt
  from the plugins in seconds is a cache, not a source of truth. Treating it as authoritative
  inverts the dependency.
- **Text as the source of truth, binary as compiled artifact** — held for three days in 2026-08;
  see ADR-0042.
