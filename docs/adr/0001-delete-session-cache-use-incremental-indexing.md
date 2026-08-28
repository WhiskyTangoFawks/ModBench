---
status: accepted
---

# No cross-session index cache; plugins are added to a live session incrementally

Decided 2026-05-31.

## Context

An early design cached the index across sessions by plugin mtime (see Alternatives rejected). It
was written (`SessionCache`) but never integrated — `SessionManager.Load()` always re-indexed the
full load order. The real pain point was `CreatePlugin()`, which called `Load()` internally,
tearing down and re-indexing every plugin just to add one new empty file.

## Decision

1. **The index is rebuilt on session load; there is no persisted cache.** The DuckDB connection is
   in-memory (`DataSource=:memory:`), so any state a cache-validity check would read vanishes with
   the process. If persistent DuckDB is ever introduced, an mtime or hash strategy can be
   revisited then — never against an in-memory connection.
2. **`IGameSession.AddPlugin(filePath) → PluginMetadata`** mutates the live session in place: opens
   the plugin as a Mutagen mod overlay, registers it in the session's mod collection, and appends
   its `PluginMetadata` (`isImmutable: false`, `LoadOrderIndex` = current plugin count).
3. **`SessionManager.CreatePlugin()`** calls `AddPlugin()`, indexes the one new mod, and updates
   winners — the same pattern a save uses. No repository teardown, no full reload.
4. **The link cache is not rebuilt** in `AddPlugin`: a new plugin is always empty, so it has no
   records to resolve.

## Consequences

- `CreatePlugin()` scales to large load orders: one index call on an empty mod, not a full
  re-index of N plugins.
- Copying records into a new plugin (create empty plugin → edit → Save & Compile) works through
  the normal edit path (ADR-0041) with no reload.

## Alternatives rejected

- **mtime-based incremental reindex across sessions (2026-05).** Compare each plugin's
  `file_mtime` against a stored timestamp in an `index_state` table and skip unchanged plugins;
  a `load_order_hash` detects a changed load order. Cannot work with an in-memory DuckDB
  connection — the table vanishes on exit, so the check always misses — and wiring it in would
  have given the appearance of caching with none of the benefit.
- **Keep the `Load()` call in `CreatePlugin()`** — acceptable for small load orders; unacceptable
  for a 200-plugin load order where adding a blank plugin triggers a full re-index.
- **Load existing plugins into a live session** — not a required use case for creating a plugin;
  unlisted plugins are loaded read-only by their own door (`POST /plugins/load`).
