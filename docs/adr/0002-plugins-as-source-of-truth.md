# Plugins are the source of truth

> **Restored unamended by [ADR-0042](0042-plugin-is-the-source-of-truth-lossless-source-committed-binary.md) (2026-08-22).** ADR-0041 (2026-08-19)
> had amended this for *tracked* mods — text as the working source, the binary as a
> compiled artifact. ADR-0042 returns the plugin to being the source of truth for
> tracked and untracked mods alike: a tracked mod's source text is a lossless,
> gate-verified editable form of the same truth, and the plugin itself is committed
> beside it. The "YAML via Spriggit" rejection below was vindicated a second time, for
> a new reason: Spriggit's format is lossy by design.

The `.esp`/`.esm`/`.esl` binary files on disk are the authoritative source of record data. No intermediate format is introduced. The plugin is what the game reads, what every other tool in the ecosystem understands, and what the user ships — there is no drift problem, no synchronization problem, and no format translation cost.

## Considered options

**YAML via Spriggit** — Spriggit serializes plugins to YAML for version control. Using YAML as a working format introduces three representations of the data (binary, YAML, index), a hard runtime dependency on a .NET CLI tool, 3–5× disk amplification, and an unclear session lifetime. Rejected.

**SQLite as source of truth** — A database that can be deleted and rebuilt from the plugins in under 30 seconds is a cache, not a source of truth. Treating it as authoritative inverts the dependency. Rejected.
