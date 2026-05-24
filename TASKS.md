# mEdit — Phased Task Breakdown

**Status:** Phase 0 complete. Starting Phase 1.
**Target game (v1):** Fallout 4. Other games behind a `GameRelease` enum later.

---

## Phase 0 — Project Scaffold ✓

*Goal: both projects compile and start. No domain logic. Skeleton only.*

### C# Backend (`BethesdaPluginService/`)
- [x] Create solution: `BethesdaPluginService.sln`
- [x] Create `BethesdaPluginService.Core` class library
- [x] Create `BethesdaPluginService.Api` ASP.NET Core minimal API
- [x] Add NuGet deps: `Mutagen.Bethesda.Fallout4`, `DuckDB.NET`, `Swashbuckle.AspNetCore`, `Autofac.Extensions.DependencyInjection`, `Serilog.AspNetCore`
- [x] Wire Autofac into ASP.NET Core host (`UseServiceProviderFactory`)
- [x] Configure Serilog (console sink + rolling file sink)
- [x] Mount Swashbuckle → OpenAPI at `/openapi.json` and Swagger UI at `/swagger`
- [x] `GET /health` → `200 { status: "ok" }`
- [x] Verify: `dotnet run`, curl health, swagger UI loads

### VS Code Extension (`bethesda-plugin-editor/`)
- [x] Scaffold with `yo code` → TypeScript extension
- [x] Add webview build: Vite + React + TypeScript in `webview/`
- [x] Register commands in `package.json`: `mEdit.openEditor`, `mEdit.openCompare`
- [x] `extension.ts`: commands registered, each opens a placeholder webview panel
- [x] Webview renders a `<div>mEdit loading…</div>`
- [x] Verify: F5 launches Extension Development Host, commands appear in palette

---

## Phase 1 — Plugin Loading

*Goal: given a Data folder path, load plugins via Mutagen and enumerate records in memory.*

### IPluginLoader Service
- [x] Define `IPluginLoader` interface in Core
- [x] Read `Plugins.txt` (FO4 AppData path) to resolve enabled plugins and load order
- [x] Load each plugin into `LoadOrder<IModListing<IModGetter>>` via Mutagen
- [ ] Expose `IGameEnvironment` scoped to session lifetime
- [x] `PluginMetadata` model: name, path, load_order_idx, is_light, is_master, masters list, record_count
- [x] Integration test: load a known test plugin, assert record count matches xEdit

### FormKey Resolution
- [ ] `IFormKeyResolver.Resolve(FormKey) → string editorId` via winning override lookup
- [ ] `IFormKeyResolver.Search(string query, IEnumerable<string> validTypes) → FormKey[]` for FormKeyPicker
- [ ] Cache both directions in `ConcurrentDictionary` for session duration

---

## Phase 2 — DuckDB Index

*Goal: all loaded records queryable via SQL. Rebuild from plugins in <30 s. mtime-cached across sessions.*

### Schema Generator
- [ ] `SchemaGenerator.CreateTablesFor(Type recordType, DuckDBConnection conn)`
- [ ] Implement type mapping (see mEdit.md §4): `string/TranslatedString → VARCHAR`, `int/short → INTEGER`, `float/double → FLOAT`, `bool → BOOLEAN`, enum → `VARCHAR`, `FormLink<T> → VARCHAR`, 1-level struct → inline prefixed columns, 2+-level / `ExtendedList<T>` → `JSON`
- [ ] Hardcoded schema for `plugins` and `index_state` tables
- [ ] On startup: compare stored Mutagen assembly version hash → if changed, drop and recreate all generated tables
- [ ] Schema generation is idempotent (`CREATE TABLE IF NOT EXISTS`)

### Indexer
- [ ] `RecordIndexer.Index(IModGetter plugin, int loadOrderIdx)` walks all major record types
- [ ] Map each record's properties → column values via reflection (matching the schema generator's logic)
- [ ] Batch-insert via DuckDB `Appender` for performance
- [ ] Composite PK `(form_key, plugin)` — upsert semantics for incremental updates
- [ ] Compute `is_winner`: highest `load_order_idx` row for each `form_key`
- [ ] Store `file_mtime` per plugin in `plugins` table

### Session Cache
- [ ] On startup: compute `load_order_hash` (plugin list + all mtimes) → compare to `index_state`
- [ ] Hash matches: skip all plugins (instant start)
- [ ] Hash differs: reindex only plugins whose mtime changed, full reindex if load order changed
- [ ] Integration test: index a 2-plugin set, verify `is_winner` is set correctly on the override

---

## Phase 3 — Read API

*Goal: frontend can navigate plugins → record types → records → field details.*

### Endpoints
- [ ] `GET /plugins` → list of `PluginMetadata`
- [ ] `GET /records?plugin=&type=&search=&limit=&offset=` → paginated `{ items, total }`
- [ ] `GET /records/{formKey}` → record with all field values + per-field metadata
- [ ] `GET /records/{formKey}/compare` → all override rows ordered by load order + `FieldDiff[]`
- [ ] `GET /record-types` → list of record type names (for filter dropdowns)

### Field Metadata Shape
Each field in a record response includes:
- `name: string`
- `type: "string" | "int" | "float" | "bool" | "enum" | "formKey" | "struct" | "array"`
- `isArray: bool`
- `validFormKeyTypes: string[]` — derived from `FormLink<T>`'s generic parameter; empty for non-FormKey fields
- `enumValues: string[]` — for enum and flag fields

### Diff Object (CompareView)
```typescript
interface FieldDiff {
  fieldName: string
  values: Record<string, unknown>  // plugin → value
  isConflict: boolean
  winnerPlugin: string
  winnerValue: unknown
}
```
Computed server-side. Frontend is a dumb renderer.

---

## Phase 4 — Write API

*Goal: edits flow through the C# service, update DuckDB, and flush to disk on explicit save.*

### Endpoints
- [ ] `PATCH /records/{formKey}` — body: `{ plugin: string, fields: Record<string, unknown> }` → partial field update
- [ ] `POST /records/{formKey}/copy-to/{plugin}` — copy winning record as a new override into target plugin
- [ ] `POST /plugins/{plugin}/save` — write plugin to disk (create `.bak` first)
- [ ] `POST /session/load` — load a new plugin set, replacing current session
- [ ] `POST /records/{formKey}/undo` — restore pre-edit state from in-memory stack

### In-Memory Undo
- [ ] Hold pre-edit Mutagen object in `Dictionary<(FormKey, string plugin), IMajorRecord>` per session
- [ ] Undo restores the object and flushes DuckDB row
- [ ] Stack cleared on explicit save

### Backup
- [ ] Before every save: `<plugin>.<yyyy-MM-ddTHH-mm-ss>.bak`
- [ ] Keep last 5 backups per plugin; prune oldest on each save
- [ ] Return backup path in save response

---

## Phase 5 — VS Code Extension

*Goal: extension manages backend process lifetime, exposes tree view, opens webview panels.*

### Backend Process Lifecycle
- [ ] On activation: locate bundled C# binary, spawn as child process
- [ ] Poll `GET /health` until ready (timeout: 15 s, retry every 500 ms)
- [ ] Port: default 5172; fall back to random free port; store in extension context
- [ ] On deactivation: send SIGTERM, wait up to 3 s, then SIGKILL
- [ ] Restart on unexpected exit; surface error notification to user

### TypeScript API Client
- [ ] Add `openapi-typescript` (type generation) + `openapi-fetch` (runtime client) to devDeps
- [ ] `npm run generate-api`: fetch `http://localhost:{port}/openapi.json` → emit `src/generated/api.ts`
- [ ] All webview↔backend communication goes through the typed client
- [ ] Port passed to webview as initial state

### TreeView Provider
- [ ] `PluginTreeProvider implements vscode.TreeDataProvider<PluginTreeItem>`
- [ ] Level 0: plugins (from `GET /plugins`)
- [ ] Level 1: record type groups within a plugin
- [ ] Level 2: individual records — label: `EditorID`, description: `[FormKey]`
- [ ] Click on record → `mEdit.openEditor` command with FormKey arg
- [ ] Refresh command wired to tree view title bar

---

## Phase 6 — Webview UI

*Goal: users can view, navigate, and edit records; compare overrides side-by-side.*

### RecordView (`webview/RecordView.tsx`)
- [ ] `<RecordView formKey record fieldMeta />` — recursive renderer
- [ ] `<ScalarField>` — `<input>` typed to field type (string/int/float) or `<input type="checkbox">` for bool
- [ ] `<FormKeyField>` — view: clickable `EditorID [FormKey]` link; edit: opens `<FormKeyPicker>`
- [ ] `<FlagField>` — checkbox group for enum flag fields
- [ ] `<StructField>` — collapsible `<details>` section, recurses into children
- [ ] `<ArrayField>` — list of items, each recursively rendered; reorderable drag handle in edit mode
- [ ] Edit/view mode toggle; edit mode shows Save + Cancel buttons
- [ ] Save: `PATCH /records/{formKey}` → optimistic local state update

### CompareView (`webview/CompareView.tsx`)
- [ ] `<CompareView formKey diff />` — receives `FieldDiff[]` from `GET /records/{formKey}/compare`
- [ ] N columns, one per plugin, ordered by load_order_idx
- [ ] Column header: plugin name + `[idx]`
- [ ] Per-cell background: `green` = matches winner, `red` = conflicts, unstyled = unique
- [ ] "Copy to patch" button per column → `POST /records/{formKey}/copy-to/{plugin}`

### FormKeyPicker (`webview/FormKeyPicker.tsx`)
- [ ] Controlled `<input>` with 200 ms debounce
- [ ] Calls `GET /records?search=&type=<validTypes>`
- [ ] Results rendered as `EditorID [FormKey]` in a dropdown
- [ ] Keyboard nav: arrow keys move selection, Enter confirms, Escape closes
- [ ] Only shows record types valid for the target field (from `validFormKeyTypes` in field metadata)

---

## Deferred (Post-v1)

- Conflict detection dashboard — list all `form_key` values with `COUNT(*) > 1`
- ITM detection — self-join where `data` is identical across two rows for same FormKey
- DuckDB peer extension integration (SQL browsing, ad-hoc queries)
- Circular leveled list detection via recursive CTE
- Kuzu graph DB for reachability analysis (if recursive CTEs prove insufficient)
- Standalone Electron/Tauri build
- Non-FO4 game support (Skyrim SE, Oblivion) behind `GameRelease` param
- Batch operations API (bulk field edits across multiple records)
