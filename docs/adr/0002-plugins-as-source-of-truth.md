# Plugins are the source of truth

> **Amended by [ADR-0041](0041-manual-git-tracking-compile-from-text.md)
> (2026-08-19):** for a *tracked* mod (manual gesture, `.git` in the mod folder),
> per-record text is the working source and the binary is the compiled artifact —
> Save & Compile serializes text to binary, and external binary changes flow back
> through the bridge. The binary remains the interchange truth with every external
> tool, and for untracked mods this ADR stands untouched.

The `.esp`/`.esm`/`.esl` binary files on disk are the authoritative source of record data. No intermediate format is introduced. The plugin is what the game reads, what every other tool in the ecosystem understands, and what the user ships — there is no drift problem, no synchronization problem, and no format translation cost.

## Considered options

**YAML via Spriggit** — Spriggit serializes plugins to YAML for version control. Using YAML as a working format introduces three representations of the data (binary, YAML, index), a hard runtime dependency on a .NET CLI tool, 3–5× disk amplification, and an unclear session lifetime. Rejected.

**SQLite as source of truth** — A database that can be deleted and rebuilt from the plugins in under 30 seconds is a cache, not a source of truth. Treating it as authoritative inverts the dependency. Rejected.
