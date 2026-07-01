# mEdit — Deferred / Stretch Goals

## Technical debt

<!-- modbench-2.3 surfaced — super low priority, not triggered by normal MO2 profiles -->

- **`ModListProvider.load()` should return error node, not empty list** — `load()` catches and logs but returns `undefined`, so `getChildren` shows an empty tree with no user-visible feedback. Requires a new `ErrorNode` tree item; violates the CLAUDE.md invariant "error node instead of empty list when tree fetch fails."
- **`moveToSeparator` QuickPick logic belongs in `IModlistSource`, not `extension.ts`** — reads `readModlist()` directly in the command handler to build the separator list and determine placement, which is business logic. Per `medit-vscode/CLAUDE.md`, `extension.ts` is the composition root with no business logic; this should be a new `IModlistSource` method.
- **`modifyModlist` is not serialized** — concurrent calls (e.g. fast successive DnD drops) each read→transform→write independently; second write clobbers the first. Fix with a per-instance lock/queue if concurrent writes ever become a concern.
- **`removeMod` two-phase write is not atomic** — writes modlist.txt then `rm -rf mods/<name>/`. A crash between the two leaves the mod directory but no modlist entry; on reload, MO2 shows the mod as unmanaged. Fix: delete directory first (reversible via Recycle Bin or backup), then remove from modlist.
- **BOM on first modlist.txt line** — `parseModlist` and `isEntryLine` check `raw[0]` for `+`/`-`; a UTF-8 BOM (`﻿`) on the first line causes that entry to be silently skipped. MO2 does not write BOMs, so this is theoretical. Strip BOM before parsing if it becomes an issue.

- **Cache `pluginMasters` dict on session** — `RecordQueryService.GetCompare` rebuilds `Plugins.ToDictionary(p => p.Name, p => p.Masters)` on every compare call; session is immutable so this can be computed once at session-load time and stored on `IGameSession` or lazily on the service. Low priority until 255-plugin load orders become common.
- **Fold injection into `ComputeConflictAll`** — `IsInjectedRecord` post-hoc overwrites `conflictAll` after classification finishes, meaning `ConflictCritical` fires even on `NoConflict`/`Override` injected records. Clarify the domain rule (is an injected but content-identical record still critical?) then move injection into `ComputeConflictAll` so it's one factor in the grade rather than a silent override.
- **`PluginContext` record for `IConflictClassifier`** — the interface takes `IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters`, a raw projection of `PluginMetadata`. If the classifier needs a second property (e.g. implicit-master flag for `.esm` injection semantics), a second parallel dict would need threading through. Introduce a small `record PluginContext(string Name, IReadOnlyList<string> Masters)` and map `PluginMetadata → PluginContext` in `RecordQueryService`. Do this when the classifier needs its second property.

## Near-term deferred
- **Non-FO4 game support** — backend architecture complete (Phase M); blocked on adding `Mutagen.Bethesda.Skyrim`, `.Oblivion`, `.Starfield` NuGet packages + extension game-picker wiring. Spec + running game-coupling findings list: [multi-game-enablement](multi-game-enablement.md)
- **Backend binary bundled in VSIX** — package .NET self-contained binary into the extension so users don't need a separate install step
- **MO2 native reconstruction** — doc: add backend exe to MO2 Tools, start from MO2 → attached mode works normally
- Parallelize plugin loading and investigate DB saved local DB State- either for entire DB, or just for pending changes (so they survive a restart)

## Power / analysis features
- **Build Reachable Info** — graph traversal from known entry points through all record references; marks unreachable records stricken-through; complex, low ROI for most users
- **Conflict resolution assistant** — "Apply All Wins" batch action: copies all winning-override field values to a designated patch plugin in one operation
- **Diff export** — save conflict report (all overrides for selected records) to `.txt` or `.html`
- **Circular leveled list detection** — recursive CTE query to find cycles in `lvln`/`lvli` chains
- **Batch field edits** — `PATCH /records` supporting multiple FormKeys in one request for bulk operations

## Future explorations
- Sideloading
    * Open plugin file outside a load order (mutagen grabs the default steam load order to deal with masters)
    * Import/Export from Spriggit
- Agentic integration - ACP/MPC?
- Extra mutagen tooling
    * Analysis
    * Merge Plugins
    * ???
- **REFR spatial rendering** — select placed-object (`REFR`) records, render their 3D cell positions on a top-down map; use DuckDB spatial extension (`ST_Within`, radius queries) for proximity searches; requires a Three.js or Canvas 2D renderer webview
- Navmesh editing
- Previsibine generation
- **Asset handling** — resolve loose-file and BA2-packed assets referenced by records (textures, meshes, sounds); repeat XEdit hash textures so faction paintjob distribution can be migrated
- Vector DB for semantic lookup with standalone MCP server → this work is inherently template based, so being able to do a lookup is going to be fairly critical for a more automated agent → need to dump the FO4 wiki here too...

## MO2 Functionality

Full spec: [docs/mod-manager.md](../mod-manager.md)

- Sidebar mod list view (enable/disable, drag-and-drop priority ordering) → plugin list view on launch
- VFS via VS Code run config (Linux: fuse-overlayfs, Windows: ProjFS) — BA2s treated as opaque files, no extraction
- File conflict index (winner-per-path map, rebuilt on reorder/toggle)
- Status badges: conflicts, missing masters, update available
- nxm:// Nexus download integration
- Manual archive install with SharpCompress


## Nifskope in VSCode

### Shortcut A: The Python Bridge (PyFFI)
The NifTools team maintains PyFFI (Python File Format Interface), a Python library capable of reading and editing NIF blocks.  The Glue: Instead of compiling C++ to WASM, bundle a lightweight Python script with your extension. Your TypeScript code calls the Python script headlessly via standard child processes (child_process.spawn). Python reads the NIF, turns it into JSON for your Agent, and edits it on command. This completely eliminates C++ compilation headaches.
### Shortcut B: The CLI Bridge via Blender
Blender has an incredibly robust, community-maintained Blender NIF Plugin.  The Glue: You could use a headless instance of Blender as your background processor. Your extension triggers background Python scripts inside Blender to import the NIF, alter a transform or material via the Blender API, and re-export it.