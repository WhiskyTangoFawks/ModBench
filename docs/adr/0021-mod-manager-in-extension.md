# Mod manager lives in the VS Code extension, not the C# backend

The mod-management subsystem (install, enable/disable, ordering, file-conflict index, hardlink deploy/purge, game-path resolution) lives in the VS Code extension (`medit-vscode/src/modmanager/`), not in `MEditService`. Mod management is file/HTTP/JSON work that never parses plugin binaries — the one exception, reading a plugin's master list for missing-master and load-order sorting, is a small `TES4`-header read, not a Mutagen-sized concern. Node provides hardlinks natively (`fs.link`), and the entire mod-manager UI surface (tree views, `SecretStorage`, status bar, `nxm://` handler) already lives in the extension, so a C# home would mean a chatty HTTP API wrapped around inherently UI-adjacent bookkeeping. The editing backend stays a pure Mutagen + DuckDB record service.

## Considered options

**Mod manager in the C# backend** (as originally drafted in `docs/mod-manager.md`) — rejected: nothing to reuse from the Mutagen/DuckDB core, and `CreateHardLink`/`link` P/Invoke is strictly harder than Node's native `fs.link`.

**Separate C# mod-manager service** — rejected: a second process, HTTP API, and OpenAPI client for what is pure file work.
