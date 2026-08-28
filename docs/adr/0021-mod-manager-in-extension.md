---
status: accepted
---

# Mod management lives in the VS Code extension, on MO2's own on-disk format

## Decision

**The mod-management subsystem lives in the extension** (`modbench/src/modmanager/`), not in
`MEditService`: install, enable/disable, ordering, file-conflict index, hardlink deploy/purge,
game-path resolution. Mod management is file/HTTP/JSON work that never parses plugin binaries —
the one exception, reading a plugin's master list for missing-master and load-order sorting, is
a small `TES4`-header read, not a Mutagen-sized concern. Node provides hardlinks natively
(`fs.link`), and the entire mod-manager UI surface (tree views, `SecretStorage`, status bar,
`nxm://` handler) already lives in the extension, so a C# home would mean a chatty HTTP API
wrapped around inherently UI-adjacent bookkeeping. The editing backend stays a pure Mutagen +
DuckDB record service.

**Its on-disk format is MO2's.** Modbench does not invent a modlist format: a mod is a
`mods/<name>/` folder, enable state and mod override order live in a profile's `modlist.txt`
(`+`/`-` prefix; top of file = winning end), load order in `plugins.txt`, per-mod Nexus metadata
in `meta.ini`, and the instance conventions (`mods/`, `profiles/`, `downloads/`, `overwrite/`,
`ModOrganizer.ini`) are inherited whole — MO2 profiles come nearly for free. The driving
requirement is "point Modbench at an MO2 folder and work on their modlist" — *work on*, not
import. Sharing the format means edits round-trip and a user can alternate between MO2 and
Modbench on the same instance with zero conversion and no divergence. Writes are byte-faithful
surgical edits (separators, comments, metadata preserved verbatim — `modbench/CLAUDE.md`).

## Alternatives rejected

- **Mod manager in the C# backend** — nothing to reuse from the Mutagen/DuckDB core, and
  `CreateHardLink`/`link` P/Invoke is strictly harder than Node's native `fs.link`.
- **Separate C# mod-manager service** — a second process, HTTP API and OpenAPI client for what is
  pure file work.
- **A native `modlist.json` with an MO2 importer** — a one-way importer makes MO2 second-class by
  construction and lets the two lists diverge.
- **Vortex adapter** — deferred; read-first if a real need arrives.
