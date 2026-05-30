# mEdit — Task Roadmap

**POC complete** (Phases 0–7 + M). Core stack operational: plugin loading, DuckDB index, record compare grid, inline edit + save, FormKey picker, session wizard, backend lifecycle.

**Target game (v1):** Fallout 4. Multi-game architecture complete (Phase M); other games need NuGet packages + extension wiring.

---

## Completed Phases ✓

| Phase | Summary |
|-------|---------|
| **0** | Solution scaffold — C# backend + VS Code extension compile and start; `GET /health` live |
| **1** | Plugin loading — `IPluginLoader`, `PluginMetadata`, `IFormKeyResolver`; integration test |
| **2** | DuckDB index — `SchemaGenerator`, `RecordIndexer`, `UpdateWinners`, `SessionCache`; winner test |
| **3** | Read API — `/plugins`, `/record-types`, `/records`, `/records/{fk}`, `/records/{fk}/compare` |
| **4** | Write API — `PATCH /records/{fk}`, `POST /copy-to`, `GET/DELETE /changes`, `POST /save`; `PluginWriter`; backups |
| **5** | VS Code extension — backend lifecycle, status bar, session wizard, game path detection, generated API client |
| **5.1** | Tree drill-down — plugin → record type → record nodes; pagination; click → `mEdit.openEditor` |
| **6** | Webview read-only — compare grid (field × plugin), conflict highlighting, FormKey links |
| **M** | Multi-game architecture — `GameRelease` threaded through stack; implicit plugin loading; immutable base-game enforcement |
| **7** | Webview edit mode — inline field editing, pending change columns, revert, save, copy-to, `FormKeyPicker` |
| **8** | UI polish: immutability enforcement (lock icon, read-only badge, pending column suppression); error surfacing (409 → "Plugin is read-only"); `POST /plugins/create`; "New Plugin…" + "Copy as Override Into…" commands; `api.ts` regenerated with all write endpoints |
| **A** | Architectural cleanup — `SchemaReflector`/`TableDdlBuilder` split, `IConflictClassifier` extracted, `PluginWriter` apply-function tests, `SessionManager` thread-safety audit, `PluginFixtureBuilder`, naming pass, RFC 7807 error model, parameterized SQL |

---

## Phase 9 — Conflict Dashboard & Filtering

*Goal: users can see the conflict landscape at a glance and drill into only the records that matter.*

### Backend
- [ ] Add conflict classification enum: `NO_CONFLICT` (1 override), `OVERRIDE` (multiple, all values agree), `CONFLICT` (multiple, values differ)
- [ ] `GET /conflicts` — returns `{ formKey, editorId, plugin, conflictType }[]` for all FormKeys with >1 override; uses DuckDB `GROUP BY` + `COUNT` + field comparison
- [ ] `GET /records?conflictState=conflict|override|clean` — extend existing query endpoint to filter by conflict classification
- [ ] `GET /plugins/{plugin}/conflicts` — conflict records scoped to one plugin's overrides

### Extension
- [ ] Top-level "Conflicts" tree node showing total conflict count; lazy-loads `GET /conflicts`
- [ ] Conflict and override badge icons on record nodes in the tree
- [ ] Filter toolbar on plugin tree: "All" / "Conflicts Only" / "Overrides Only" toggle
- [ ] `mEdit.showConflicts` command (palette + tree toolbar)

### Tests
- [ ] Backend: `GET /conflicts` returns correct counts for a two-plugin fixture with one conflicting record
- [ ] Backend: `GET /records?conflictState=conflict` filters correctly

---

## Phase 10 — ITM Detection & Cleaning

*Goal: mod authors can identify and remove Identical To Master records — the primary reason most people run xEdit.*

### Backend
- [ ] `GET /plugins/{plugin}/itms` — records in `plugin` that are identical to their lowest-load-order master override (all indexed fields match); uses DuckDB self-join
- [ ] `POST /plugins/{plugin}/clean-itms` — removes ITM records from the plugin binary via Mutagen, re-indexes, returns `{ removed: int, backupPath: string }`
- [ ] `GET /plugins/{plugin}/deleted-references` — records with deletion flag set instead of disabled+temporary pattern
- [ ] `POST /plugins/{plugin}/fix-deleted-references` — converts deleted refs to `IsDeleted=false, IsTemporary=true`; re-indexes; returns count
- [ ] `POST /plugins/{plugin}/check-errors` — structural validation: missing masters, unresolved FormLinks, malformed records; returns `ErrorReport[]`

### Extension
- [ ] "Clean Plugin…" command on plugin tree node context menu → runs ITM detection, shows count in confirmation dialog, applies on confirm
- [ ] Cleaning report webview panel: lists removed ITMs, fixed deleted refs, errors found
- [ ] `mEdit.checkErrors` command

### Tests
- [ ] Backend: ITM detection returns correct record for a plugin that copies a master record unchanged
- [ ] Backend: `clean-itms` removes record, re-indexes, leaves non-ITM records intact

---

## Phase 11 — Referenced By / Record Graph

*Goal: see every record that references a given FormKey — essential for understanding the impact of a change.*

### Backend
- [ ] `GET /records/{formKey}/references` — backend-generated `UNION ALL` across all FormLink columns in all record tables; returns `{ formKey, editorId, plugin, fieldPath }[]`
- [ ] No extra cache needed — this is a DuckDB read

### Extension / Webview
- [ ] "Referenced By" tab in the record panel (alongside the compare grid); lazy-loads on tab click
- [ ] Each reference entry: plugin chip + record EditorID + field path; clicking opens that record
- [ ] Empty state: "No references found"

### Tests
- [ ] Backend: references endpoint returns the referencing NPC when a weapon FormKey is searched
- [ ] Backend: unknown FormKey returns empty array (not 404)

---

## Phase 12 — Struct/Array Field Types

*Goal: complex fields (keyword lists, NPC traits, weapon damage entries) render instead of being silently omitted, with full type safety derived from Mutagen's reflection model.*

### Backend
- [ ] `SchemaGenerator`: serialize `IReadOnlyList<T>` / `ExtendedList<T>` as JSON `VARCHAR`; emit `type: 'array'` in field metadata; element type recursively reflected
- [ ] `SchemaGenerator`: for nested struct properties (getter interfaces, C# value types), walk the type's own properties recursively via reflection to produce a `fields: FieldMetadata[]` sub-schema — same shape as top-level field metadata, so the frontend gets `name`, `type`, `enumValues`, `validFormKeyTypes` at every nesting level
- [ ] Sub-schema generation is recursive (structs can contain FormLinks, enums, further structs); stop at primitives and known leaf types
- [ ] `PluginWriter`: handle JSON round-trip for array and struct fields on write; use sub-schema to apply individual sub-field writes with correct types (no raw string coercion)

### Extension / Webview
- [ ] `<ArrayRowGroup>`: collapsible row-group; each element a child row; add/remove in edit mode
- [ ] `<StructRowGroup>`: collapsible row-group; each property a child row with type-correct cell (uses sub-schema `FieldMetadata` to drive `ScalarCell` / `FormKeyCell` / nested group)
- [ ] Edit inputs for struct sub-fields and array elements are driven by the sub-schema type — no free-text JSON entry; the type hierarchy from Mutagen reflection is the source of truth
- [ ] Collapsed by default; expand state persisted per session

### Tests
- [ ] Backend: `SchemaGenerator` emits `type: 'array'` for a known list property (e.g. `IKeywordGetter` list)
- [ ] Backend: struct sub-schema contains correct `FieldMetadata` entries (names + types) for a known Mutagen getter interface
- [ ] Backend: array field survives round-trip through write → re-index → read

---

## Phase 13 — Spreadsheet Views

*Goal: tabular comparison of a record type across all plugins — popular for balancing weapon stats, armor values, NPC levels.*

### Backend
- [ ] `GET /spreadsheet?type=weap&plugins[]=...` — one row per FormKey, columns = field names; winner values by default; includes `conflictType` per row
- [ ] Column metadata returned alongside rows (same `FieldMetadata` shape as compare)

### Extension / Webview
- [ ] "Open Spreadsheet" command on `RecordTypeNode` context menu → opens spreadsheet webview
- [ ] Spreadsheet webview: fixed header row (field names), scrollable data rows
- [ ] Sortable columns (click header); text filter bar; plugin filter chips
- [ ] Cell conflict highlighting consistent with compare grid (green winner / red conflict)
- [ ] Click a row → opens that record's compare panel

### Tests
- [ ] Backend: spreadsheet returns correct row count for a known record type + plugin set
- [ ] Backend: conflict column set correctly for a known conflicting record

---

## Phase 14 — Plugin File Management

*Goal: operations mod authors need for preparing plugins for distribution or integration.*

### Backend
- [ ] `POST /plugins/{plugin}/compact-formids` — renumber non-master FormIDs into 0x001–0xFFF range for ESL eligibility; returns `{ remapped: int, backupPath: string }`
- [ ] `POST /plugins/{plugin}/convert` — toggle ESL/ESM flag; request body `{ targetType: "esp"|"esm"|"esl" }`
- [ ] `POST /plugins/{plugin}/masters/add` — add a new master reference to the plugin header
- [ ] `POST /plugins/{plugin}/masters/sort` — reorder masters to match current load order
- [ ] `POST /plugins/{plugin}/masters/clean` — remove unused master references (not referenced by any record)
- [ ] `POST /plugins/merge` — merge source plugin records into target plugin; adjusts FormID mapping; creates backup

### Extension
- [ ] Plugin context menu: "Compact FormIDs", "Convert to ESL / ESM", "Add Master…", "Sort Masters", "Clean Masters", "Merge Into…"
- [ ] Confirmation dialogs for all destructive operations
- [ ] Result notification (backup path, counts)

### Tests
- [ ] Backend: `compact-formids` renumbers records and updates all cross-references within the plugin
- [ ] Backend: `masters/clean` removes only the unreferenced master

---

## Phase 15 — Scripting Engine

*Goal: power users write JS scripts against the loaded mod data — the xEdit scripting experience, native to VS Code.*

### Backend
- [ ] `POST /query` — execute arbitrary SQL against DuckDB; returns `{ columns: string[], rows: unknown[][] }`; all statement types permitted (DuckDB is a cache — scripts may create temp tables, run CTEs, insert staging data; direct DuckDB writes bypass `PluginWriter` and do not affect plugin files on disk)
- [ ] `GET /scripts` — list available scripts from user-configurable folder + built-in `extension/scripts/`; returns `{ name, description, context }[]`
- [ ] Script frontmatter format: YAML header with `name`, `description`, `context` (record | plugin | global)
- [ ] Token substitution in script files: `{{formKey}}`, `{{plugin}}`, `{{editorId}}`, `{{type}}`

### Extension
- [ ] Script runtime: evaluate JS scripts in VS Code extension host (Node.js); expose `getRecord(fk)`, `patchRecord(fk, plugin, fields)`, `save(plugin)`, `getPlugins()`, `query(sql)` APIs
- [ ] `patchRecord` and `save` go through `PendingChangeService` → `PluginWriter` — scripts that write go through the same pipeline as manual edits; `query` writes go to DuckDB only
- [ ] "Run Script…" command on tree context menu + command palette; QuickPick populated from `GET /scripts`
- [ ] Script output panel (append-only log)
- [ ] User setting: `mEdit.scriptsPath` for custom script folder

### Built-in scripts (`extension/scripts/`)
- [ ] `find-references.js` — lists all records referencing current FormKey
- [ ] `list-overrides.js` — lists all FormKeys with >1 override for current plugin
- [ ] `find-itms.js` — finds ITM records in current plugin (SQL-based)
- [ ] `conflict-summary.js` — prints conflict counts by record type

### Tests
- [ ] Backend: `POST /query` returns correct rows for a SELECT statement
- [ ] Backend: `POST /query` executes a CREATE TEMP TABLE statement without error (write to DuckDB allowed)

---

## Phase 16 — ModGroups

*Goal: suppress intentional conflicts in curated mod lists so the conflict view stays signal-rich.*

### Format & Backend
- [ ] ModGroup file format: YAML listing named groups; each group is a list of plugin names whose inter-conflicts are intentional
- [ ] `GET /modgroups` — returns active modgroups loaded from `mEdit.modGroupsPath`
- [ ] `POST /modgroups` — create or update a modgroup entry
- [ ] Conflict detection in `GET /conflicts` and compare grid: skip pairs covered by an active modgroup
- [ ] `GET /records/{fk}/compare` — include `suppressedBy?: string` (modgroup name) per diff when conflict is suppressed

### Extension / Webview
- [ ] ModGroup manager panel: list groups, add/remove plugins from a group
- [ ] Suppressed conflicts shown in compare grid with neutral styling + modgroup name tooltip
- [ ] `mEdit.manageModGroups` command

### Tests
- [ ] Backend: conflict suppressed for a known pair after modgroup created
- [ ] Backend: non-grouped conflict still reported

---

## Phase 17 — CLI Automation Modes

*Goal: headless operation for MO2 / Vortex integrations and automated cleaning pipelines.*

### Backend
- [ ] `--quickautoclean <plugin>` — load session, run ITM detection, fix deleted refs, save, exit; writes cleaning log to stdout
- [ ] `--autoload` — skip interactive session wizard; load from `--data-folder` + `--plugins-txt` immediately at startup
- [ ] `--autoexit` — exit process after operation completes (for automation pipelines)
- [ ] `--quickedit:<plugin>` — pre-select only that plugin + its required masters on load

### Tests
- [ ] `CliArgs`: all new flags parse correctly; incompatible combos rejected with clear error
- [ ] Backend integration: `--quickautoclean` on a plugin with known ITMs produces correct output and exits 0

---

## Deferred / Stretch Goals

### Near-term deferred
- **Non-FO4 game support** — backend architecture complete (Phase M); blocked on adding `Mutagen.Bethesda.Skyrim`, `.Oblivion`, `.Starfield` NuGet packages + extension game-picker wiring
- **Backend binary bundled in VSIX** — package .NET self-contained binary into the extension so users don't need a separate install step
- **MO2 native reconstruction** — doc: add backend exe to MO2 Tools, start from MO2 → attached mode works normally

### Power / analysis features
- **Build Reachable Info** — graph traversal from known entry points through all record references; marks unreachable records stricken-through; complex, low ROI for most users
- **Conflict resolution assistant** — "Apply All Wins" batch action: copies all winning-override field values to a designated patch plugin in one operation
- **Diff export** — save conflict report (all overrides for selected records) to `.txt` or `.html`
- **Circular leveled list detection** — recursive CTE query to find cycles in `lvln`/`lvli` chains
- **Batch field edits** — `PATCH /records` supporting multiple FormKeys in one request for bulk operations

### Future explorations
- Agentic integration - ACP/MPC?
- Extra mutagen tooling
    * Spriggit style export
    * Analysis
    * Merge Plugins
    * ???
- **REFR spatial rendering** — select placed-object (`REFR`) records, render their 3D cell positions on a top-down map; use DuckDB spatial extension (`ST_Within`, radius queries) for proximity searches; requires a Three.js or Canvas 2D renderer webview
- **Asset handling** — resolve loose-file and BA2-packed assets referenced by records (textures, meshes, sounds); repeat XEdit hash textures so faction paintjob distribution can me migrated
- Vector DB for semantic lookup -> this work is inherently template based, so being able to do a lookup is going to be fairly critical for a more automated agent -> need to dump the FO4 wiki here too...