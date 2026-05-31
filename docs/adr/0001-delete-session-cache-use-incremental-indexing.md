# ADR-0001: Delete SessionCache; use incremental plugin indexing instead of mtime-based cache invalidation

**Status:** Accepted  
**Date:** 2026-05-31

## Context

`ARCHITECTURE.md §6` describes an mtime-based cache invalidation strategy: on session load, compare each plugin's `file_mtime` against a stored timestamp and skip re-indexing unchanged plugins. `SessionCache` was written to implement this (`ComputeLoadOrderHash`, `NeedsReindex`, `StoreState`), but was never integrated — `SessionManager.Load()` always re-indexes the full load order from scratch.

The primary pain point was `CreatePlugin()`, which called `Load()` internally, causing a full repository teardown and re-index of all plugins just to add one new empty file.

## Decision

1. **Delete `SessionCache`** — the mtime optimization it implements cannot work with an in-memory DuckDB connection (`DataSource=:memory:`). The `index_state` table it reads/writes vanishes when the process exits, so `NeedsReindex` always returns true in a fresh process. Wiring it in would give the appearance of caching with none of the benefit.

2. **Add `IGameSession.AddPlugin(filePath) → PluginMetadata`** — mutates the live session in place: opens the plugin file as a Mutagen mod overlay, registers it in the session's mod collection, and appends its `PluginMetadata` (with `isImmutable: false`, `LoadOrderIndex` = current plugin count).

3. **Fix `SessionManager.CreatePlugin()`** to call `_session.AddPlugin()` + `_repository.Index(mod, loadOrderIndex)` + `_repository.UpdateWinners()` — the same pattern `SavePlugin()` already uses. No repository teardown. No full reload.

4. **Link cache is not rebuilt** in `AddPlugin`. New plugins are always empty (mEdit only creates blank plugins; existing plugins are never loaded into a live session). An empty plugin has no records to resolve through the link cache, so rebuilding it is unnecessary.

## Consequences

- `CreatePlugin()` scales to large load orders: adding a new plugin costs one index call on an empty mod, not a full re-index of N plugins.
- The "copy records into new plugin" workflow (create empty plugin → stage changes → save) works correctly: `CreatePlugin()` registers the plugin, subsequent `PATCH` + `save` flow through the existing pending-change and `SavePlugin()` paths unchanged.
- If persistent DuckDB is ever introduced (e.g., for cross-session load-order-hash caching), the mtime optimization can be revisited. At that point a new `SessionCache`-like module makes sense. Do not reintroduce it against an in-memory connection.

## Alternatives rejected

- **Wire `SessionCache` into `Load()`** — requires persistent DuckDB to provide any benefit. With `:memory:`, `NeedsReindex` always misses. Rejected.
- **Keep `Load()` call in `CreatePlugin()`** — acceptable for small load orders; unacceptable for a 200-plugin load order where adding a blank plugin triggers full re-index.
- **Load existing plugins into a live session** — not a required use case. The "copy records" feature creates a new empty plugin and stages changes via the pending-change service; it does not require loading external plugins mid-session.
