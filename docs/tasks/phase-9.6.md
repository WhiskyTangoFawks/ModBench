# Phase 9.6 — Record Filtering

**Status: Complete**

*Goal: users and agents filter the record tree by writing a DuckDB SQL SELECT that returns `form_key`. The filter is a stateful session concept on the backend; the frontend UX is file-based — `.sql` files with Code Lens, the same surface Phase 15 scripts use.*

---

## Design

A **record filter** is a DuckDB SQL SELECT stored on the backend session. While active, all record tree queries — plugin list, record-type counts, record pages — return only matching records. Plugins and record types with zero matching records are hidden entirely from the tree.

The filter SQL must return a `form_key` column. Any other returned columns are ignored. The user writes against the real per-type DuckDB tables (`"NPC_"`, `"WEAP"`, etc.) — no query abstraction layer.

```sql
-- pending-changes.sql (built-in preset)
SELECT DISTINCT form_key FROM pending_changes
```

```sql
-- user-written: NPC overrides for a specific race
SELECT form_key FROM "NPC_" WHERE race = '000800:Fallout4.esm'
```

Filters are plain `.sql` files in `mEdit.scriptsPath`. VS Code provides syntax highlighting for free. A **Code Lens** on the file (`▶ Apply as Filter` / `✓ Active — click to clear`) is the primary apply/clear affordance. A tree title bar funnel button opens a QuickPick over all `.sql` files in the scripts folder. This is the same file-based surface Phase 15 scripts occupy — a filter file is a degenerate script: a `query:` with no Python body.

**No text substitution macros in Phase 9.6.** Users write real DuckDB SQL against real table names. `{all-tables}` and `{plugin}` are deferred.

**Conflict-status filtering** is achieved by writing SQL, not by a dedicated toggle. The "All / Conflicts / Overrides / Clean" toolbar from the original spec is dropped; SQL replaces it entirely.

**Agent surface** is the same as the human surface: `POST /session/filter` (one call), then navigate normally via `GET /plugins`, `GET /plugins/{plugin}/record-types`, `GET /records`. No separate data path.

---

## Backend

- [ ] `POST /session/filter` — accepts `{ sql: string }`; validates by executing with `LIMIT 0` and checking result schema includes `form_key`; materializes results into a `_filter` DuckDB table (`form_key VARCHAR`); stores SQL string on session; returns 400 + RFC 7807 problem detail on validation failure
- [ ] `DELETE /session/filter` — drops `_filter` table; clears stored SQL from session
- [ ] `GET /session/filter` — returns `{ sql: string | null }`
- [ ] `IGameSession` — add `string? FilterSql { get; set; }`
- [ ] `DuckDbRecordRepository` — `GetRecords`, `SearchRecords`, `CountRecordsForPlugin` append `AND form_key IN (SELECT form_key FROM _filter)` when `_filter` table exists
- [ ] `IRecordReader` — add `GetPluginsWithMatchingRecords(IEnumerable<string> tableNames)` returning `IReadOnlySet<string>`; used to prune plugin list when filter is active
- [ ] `RecordQueryService.GetPlugins` — when filter active, call `GetPluginsWithMatchingRecords` and exclude plugins not in the result set
- [ ] `RecordQueryService.GetRecordTypes` (i.e. `GetPluginRecordTypes`) — when filter active, `CountRecordsForPlugin` already respects filter; zero-count types already excluded by existing `Where(x => x.Count > 0)` predicate — no additional change needed

---

## Frontend

- [ ] `mEdit.scriptsPath` setting (string, default `~/.medit/scripts`) — introduced here; Phase 15 inherits it
- [ ] On extension activate: ensure `mEdit.scriptsPath` directory exists; copy `extension/scripts/pending-changes.sql` into it if not already present
- [ ] `extension/scripts/pending-changes.sql` — built-in preset: `SELECT DISTINCT form_key FROM pending_changes`
- [ ] `mEdit.setFilter` command — opens QuickPick listing `.sql` files in `mEdit.scriptsPath` plus a "New filter…" option; selecting a file reads its content, calls `POST /session/filter`, updates cached active filter SQL, calls `treeProvider.refresh()`; "New filter…" opens an untitled `.sql` document
- [ ] `mEdit.clearFilter` command — calls `DELETE /session/filter`, clears cached active filter SQL, calls `treeProvider.refresh()`
- [ ] `FilterCodeLensProvider` — registered for `.sql` language, scoped to files under `mEdit.scriptsPath`; compares document content to cached active filter SQL; shows `▶ Apply as Filter` or `✓ Active — click to clear`; extension caches active filter SQL in memory (updated by `setFilter`/`clearFilter`/`GET /session/filter` on attach) to avoid per-render HTTP calls
- [ ] `editor/title` menu contribution — funnel-slash icon; `when: mEdit.filterActive`; calls `mEdit.clearFilter`
- [ ] `view/title` menu contributions on `mEdit` view — funnel icon always visible → `mEdit.setFilter`; funnel-slash icon `when: mEdit.filterActive` → `mEdit.clearFilter`
- [ ] `mEdit.filterActive` VS Code context key — set `true`/`false` by `setFilter`/`clearFilter`/session state sync
- [ ] `EXPECTED_COMMANDS` updated with `mEdit.setFilter`, `mEdit.clearFilter`

---

## Tests

**Backend**
- [ ] `POST /session/filter` with valid SQL returning `form_key` → 200; subsequent `GET /records?type=X` returns only matching records
- [ ] `POST /session/filter` with SQL that does not return `form_key` column → 400
- [ ] `POST /session/filter` with syntactically invalid SQL → 400
- [ ] `DELETE /session/filter` → subsequent `GET /records` returns full unfiltered tree
- [ ] `GET /plugins` with active filter → excludes plugins with no matching records
- [ ] `GET /plugins/{plugin}/record-types` with active filter → excludes types with no matching records

**Frontend**
- [ ] `mEdit.setFilter` and `mEdit.clearFilter` in `EXPECTED_COMMANDS`
- [ ] `FilterCodeLensProvider` registered; returns lenses for `.sql` documents in scripts path

---

## Proof

**Gates (2026-06-09)**
- Backend: 353 tests passed (0 failed)
- Frontend: 132 unit tests passed (0 failed)
- Mutation tests: exit 0 — no survivors, no NoCoverage

**Simplify findings applied:**
- `CountRecordsForPlugin` now routes through `BuildWhere` (was hand-building filter clause)
- `GetPluginsWithMatchingRecords` inner `DISTINCT` removed (outer `SELECT DISTINCT` is sufficient)
- `SetFilter`/`ClearFilter` on `SessionManager` collapsed into private `ApplyFilter`
- POST/DELETE `/session/filter` endpoints: added `InvalidOperationException → 503` catch (matching `PluginEndpoints` pattern), removed redundant pre-checks

**Code-review findings applied (8 of 10):**
- `ApiPluginRepository.clearFilter` — added `response.ok` check and error logging
- `ApiPluginRepository.setFilter` — added try/catch matching other methods
- `FilterCodeLensProvider` — added `onDidChangeCodeLenses` EventEmitter; fires on `setActiveSql`
- POST `/session/filter` `ArgumentException` catch — added `logger.LogError`
- POST `/session/filter` `{"sql": null}` — now returns 400 instead of silently clearing
- GET `/session/filter` — now returns 503 when no session (was 200 with null)
- `onBackendConnected` rejection — added `.catch()` to log and not silently skip `syncFilterState`
- `FilterCodeLensProvider.startsWith` — fixed missing path separator
- Findings #1 (DuckDB connection concurrency) and #7 (`_filterActive` non-volatile) dropped — both are pre-existing patterns appropriate for a single-user local tool

**Mutation tests (2 findings resolved):**
- `InMemoryRecordRepository.GetPluginsWithMatchingRecords` — added 2 integration tests
- `GameSession` logger null-coalescing — added integration test with `CapturingLogger`
