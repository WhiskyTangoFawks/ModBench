# Modbench — Task Roadmap

**POC complete** (Phases 0–7 + M). Core stack operational: plugin loading, DuckDB index, record compare grid, inline edit + save, FormKey picker, session wizard, backend lifecycle.

**Target game (v1):** Fallout 4. Multi-game architecture complete (Phase M); other games need NuGet packages + extension wiring.

Each phase has its own spec file in [docs/tasks/](docs/tasks/). Completed phases carry a **Proof** section with test output and commit hash.

---

## Phases

| Phase | Status | Summary | Spec |
|-------|--------|---------|------|
| **0** | ✓ POC | Solution scaffold — C# backend + VS Code extension compile and start; `GET /health` live | [phase-0](docs/tasks/phase-0.md) |
| **1** | ✓ POC | Plugin loading — `IPluginLoader`, `PluginMetadata`, `IFormKeyResolver`; integration test | [phase-1](docs/tasks/phase-1.md) |
| **2** | ✓ POC | DuckDB index — `SchemaGenerator`, `RecordIndexer`, `UpdateWinners`, `SessionCache`; winner test | [phase-2](docs/tasks/phase-2.md) |
| **3** | ✓ POC | Read API — `/plugins`, `/record-types`, `/records`, `/records/{fk}`, `/records/{fk}/compare` | [phase-3](docs/tasks/phase-3.md) |
| **4** | ✓ POC | Write API — `PATCH /records/{fk}`, `POST /copy-to`, `GET/DELETE /changes`, `POST /save`; `PluginWriter`; backups | [phase-4](docs/tasks/phase-4.md) |
| **5** | ✓ POC | VS Code extension — backend lifecycle, status bar, session wizard, game path detection, generated API client | [phase-5](docs/tasks/phase-5.md) |
| **5.1** | ✓ POC | Tree drill-down — plugin → record type → record nodes; pagination; click → `mEdit.openEditor` | [phase-5.1](docs/tasks/phase-5.1.md) |
| **6** | ✓ POC | Webview read-only — compare grid (field × plugin), conflict highlighting, FormKey links | [phase-6](docs/tasks/phase-6.md) |
| **M** | ✓ POC | Multi-game architecture — `GameRelease` threaded through stack; implicit plugin loading; immutable base-game enforcement | [phase-M](docs/tasks/phase-M.md) |
| **7** | ✓ POC | Webview edit mode — inline field editing, pending change columns, revert, save, copy-to, `FormKeyPicker` | [phase-7](docs/tasks/phase-7.md) |
| **8** | ✓ POC | UI polish: immutability enforcement, error surfacing, `POST /plugins/create`, new commands, `api.ts` regenerated | [phase-8](docs/tasks/phase-8.md) |
| **A** | ✓ POC | Architectural cleanup — `SchemaReflector`/`TableDdlBuilder` split, conflict classifier, thread-safety audit, RFC 7807, parameterized SQL | [phase-A](docs/tasks/phase-A.md) |
| **B** | ✓ | Pending change model redesign — ADR-0017, DuckDB-backed storage design, field-level granularity | [phase-B](docs/tasks/phase-B.md) |
| **B.1** | ✓ POC | Migrate `PendingChangeService` to DuckDB — prerequisite for Phase 9 `hasDelta` filter and Phase 15 scripting | [phase-B1](docs/tasks/phase-B1.md) |
| **B.2** | Not Started | Pending-overlay read views — generated per-type DuckDB views overlay `pending_changes` onto committed tables so filter/script SQL sees staged state; prerequisite for Phase 15 | [phase-B2](docs/tasks/phase-B2.md) |
| **9** | ✓ | Conflict classification — two-axis `ConflictAll`/`ConflictThis` enums, compare grid row/column coloring | [phase-9](docs/tasks/phase-9.md) |
| **9.5** | ✓ | ConflictPriority refinements — sorted array detection, injected record detection; `cpIgnore`/`cpBenign` deferred | [phase-9.5](docs/tasks/phase-9.5.md) |
| **9.6** | ✓ | Record filtering — SQL-derived conflict filter, free-text EditorID search, conflict tree node + toolbar | [phase-9.6](docs/tasks/phase-9.6.md) |
| **9.7** | ✓ | Per-cell CellStates conflict coloring — per-plugin `ConflictThis` cell backgrounds in the compare grid | [phase-9.7](docs/tasks/phase-9.7.md) |
| **9.8** | ✓ | Struct sub-row display — `FieldDiff.Children`, expand/collapse toggle, per-sub-field conflict coloring and editing | [phase-9.8](docs/tasks/phase-9.8.md) |
| **10** | Not Started | Record lifecycle — create, delete, renumber; `ChangeGroup`; atomic multi-plugin save | [phase-10](docs/tasks/phase-10.md) |
| **11** | ✓ POC | Referenced By / record graph — `form_references` DuckDB table, "Referenced By" tab in record panel | [phase-11](docs/tasks/phase-11.md) |
| **12** | Not Started | Complex field display — xEdit unified tree model for arrays, flag enum cells, struct edit verification | [phase-12](docs/tasks/phase-12.md) |
| **13** | Not Started | VMAD (Papyrus script data) — dedicated DuckDB tables, separate import/hydration, Scripts/Properties in compare grid, **fully editable to TES5Edit parity** (8 sub-phases) | [phase-13](docs/tasks/phase-13.md) |
| **14** | Not Started | Plugin file management — compact FormIDs, ESL convert, master clean/sort/add, merge, inject-to-master | [phase-14](docs/tasks/phase-14.md) |
| **15** | Not Started | Scripting engine — Python scripts with YAML frontmatter + SQL query; `edit()` API; built-in scripts | [phase-15](docs/tasks/phase-15.md) |
| **16** | Not Started | Worldspace/Cell tree — WRLD block hierarchy, CELL nodes with XCLC coords, REFR persistent/temporary split | [phase-16](docs/tasks/phase-16.md) |
| **17** | Not Started | Record editor column interactions — collapse, drag-drop values, "Copy All to Pending" context menu | [phase-17](docs/tasks/phase-17.md) |
| **M.1** | In Spec | Multi-game enablement — non-FO4 NuGet packages + game-picker wiring; running game-coupling findings list (VMAD indexer first) | [multi-game-enablement](docs/tasks/multi-game-enablement.md) |

---

## Mod Manager track (Mod Management context)

MO2-compatible mod manager built into the extension — spec [docs/mod-manager.md](docs/mod-manager.md). Spike-first: `load-explicit` session de-risks the lifecycle unknown before any UI is built. Modbench-2→4 stand alone (no editor coupling); Modbench-5 unifies with the editor.

| Task | Status | Summary | Spec |
| --- | --- | --- | --- |
| **modbench-1** | ✓ | **Spike** — `load-explicit` backend session from ordered scattered physical paths | [modbench-1](docs/tasks/completed-tasks/modbench-1.md) |
| **modbench-2** | ✓ | Mod list core — `GameDirectory`, MO2 `IModlistSource`, tree, enable/disable + ordering | [modbench-2](docs/tasks/completed-tasks/modbench-2.md) |
| **modbench-3** | ✓ | File conflict index + status badges, `MasterReader` | [modbench-3](docs/tasks/completed-tasks/modbench-3.md) |
| **modbench-4** | ✓ | Deployer — hardlink deploy/purge, manifest, launch wiring (standalone) | [modbench-4](docs/tasks/completed-tasks/modbench-4.md) |
| **modbench-5** | ✓ | Editing integration — `BackendManager` spawn/teardown, modlist → session | [modbench-5](docs/tasks/completed-tasks/modbench-5.md) |
| **modbench-6** | ✓ | Install from archive/folder; FOMOD detection (flag only) | [modbench-6](docs/tasks/completed-tasks/modbench-6.md) |
| **modbench-7** | Not Started | Nexus `nxm://` download integration, API key storage | [modbench-7](docs/tasks/modbench-7.md) |
| **modbench-8** | Not Started | Nexus update-available check + badge | [modbench-8](docs/tasks/modbench-8.md) |
| **modbench-9** | Not Started | Plugin load order — `plugins.txt` reorder + dependency auto-sort | [modbench-9](docs/tasks/modbench-9.md) |

---

See [docs/tasks/future-explorations.md](docs/tasks/future-explorations.md) for deferred, stretch, and long-term ideas.
