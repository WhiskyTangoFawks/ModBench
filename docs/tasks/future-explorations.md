# mEdit — Deferred / Stretch Goals

## Near-term deferred
- **Non-FO4 game support** — backend architecture complete (Phase M); blocked on adding `Mutagen.Bethesda.Skyrim`, `.Oblivion`, `.Starfield` NuGet packages + extension game-picker wiring
- **Backend binary bundled in VSIX** — package .NET self-contained binary into the extension so users don't need a separate install step
- **MO2 native reconstruction** — doc: add backend exe to MO2 Tools, start from MO2 → attached mode works normally

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
