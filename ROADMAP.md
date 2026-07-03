# Modbench — Roadmap

**Where work lives:** durable surface specs in [docs/specs/](docs/specs/); work items (PRDs and vertical-slice issues) on [GitHub Issues](https://github.com/WhiskyTangoFawks/mEdit/issues); completed phase specs (with proofs) archived in [docs/tasks/completed-tasks/](docs/tasks/completed-tasks/).

## Workflow

Per initiative: `/grill-with-docs` (sharpen the idea; updates CONTEXT.md/ADRs) → `/to-prd` (publish a PRD issue) → `/to-issues` (split into vertical-slice issues, `ready-for-agent`) → one fresh session per issue with `/implement` → when the slices ship, **fold the outcome into the surface spec**. Bugs via `/qa`; incoming external issues via `/triage` (once external users exist).

## Status

**Target game (v1): Fallout 4.** Multi-game architecture is in place (Phase M); other games need NuGet packages + wiring (#8).

Completed (specs + proofs in [completed-tasks/](docs/tasks/completed-tasks/)): phases 0–9.8 (core stack: plugin loading, DuckDB index, read/write API, extension, compare grid, conflict classification, SQL filters), 10.x (record lifecycle + ChangeGroups), 11 (Referenced By), 12.x (complex field display), 13.x (VMAD to TES5Edit parity), 16.x (worldspace/cell tree), A/B/B.1 (architecture + pending-change model), M (multi-game architecture), and modbench-1–6 (MO2-compatible mod manager: modlist, conflicts, hardlink deploy, editing integration, archive install).

## Open work (migrated from the former phase files)

| Issue | Title | Label |
|---|---|---|
| [#1](https://github.com/WhiskyTangoFawks/mEdit/issues/1) | Phase 14 — Plugin File Management (compact FormIDs, ESL convert, masters, merge) | ready-for-agent |
| [#2](https://github.com/WhiskyTangoFawks/mEdit/issues/2) | Phase 15 — Scripting Engine (Python + SQL frontmatter) | ready-for-agent |
| [#3](https://github.com/WhiskyTangoFawks/mEdit/issues/3) | Phase 17 — Record Editor Column Interactions | ready-for-agent |
| [#4](https://github.com/WhiskyTangoFawks/mEdit/issues/4) | Phase B.2 — Pending-Overlay Read Views (prereq for #2) | ready-for-agent |
| [#5](https://github.com/WhiskyTangoFawks/mEdit/issues/5) | Modbench-7 — Nexus download integration | ready-for-agent |
| [#6](https://github.com/WhiskyTangoFawks/mEdit/issues/6) | Modbench-8 — Nexus update check | ready-for-agent |
| [#7](https://github.com/WhiskyTangoFawks/mEdit/issues/7) | Modbench-9 — Plugin load order | ready-for-agent |
| [#8](https://github.com/WhiskyTangoFawks/mEdit/issues/8) | Multi-Game Enablement | needs-triage |
| [#9](https://github.com/WhiskyTangoFawks/mEdit/issues/9) | Tech debt — Cross-platform backend publishing | needs-triage |

## Planned initiatives (each starts as a `/grill-with-docs` → `/to-prd` session)

Seeded from the [MO2/Vortex feature inventory](docs/research/mod-manager-feature-inventory.md):

- **Downloads surface v1** — grill [docs/specs/downloads.md](docs/specs/downloads.md)'s open questions (queue UI shape, downloads directory, retention), then build; may absorb or supersede #5/#6.
- **Plugins / load-order surface decision** — own tab (MO2 model) vs part of mEdit vs a Mods-view mode; LOOT masterlist vs dependency-only sort. Informs how #7 lands.
- **FOMOD installers** — currently detect-and-flag only; a full `ModuleConfig.xml` installer is its own initiative.
- **Overwrite folder UX** — surface to reassign/discard files collected on purge.
- **Alpha readiness** — cross-platform packaging (#9), MO2 round-trip fidelity corpus, onboarding for the first external super-users.

## Ideas (unshaped — promote to an initiative or issue when picked up)

### Known small tech debt

- `ModListProvider.load()` should return an error node, not an empty list (violates the error-surfacing invariant).
- `moveToSeparator` QuickPick logic belongs in `IModlistSource`, not `extension.ts`.
- `modifyModlist` is not serialized — fast successive writes can clobber each other.
- `removeMod` two-phase write is not atomic (modlist entry vs directory removal).
- BOM on first `modlist.txt` line silently skips that entry (theoretical; MO2 writes no BOM).
- Cache `pluginMasters` dict on session (rebuilt per compare call).
- Fold injection into `ComputeConflictAll` (clarify: is an injected but content-identical record still critical?).
- `PluginContext` record for `IConflictClassifier` when it needs a second per-plugin property.

### Deferred features

- Parallelize plugin loading; persist DB state (or at least pending changes) across restarts.
- MO2 native reconstruction — add the backend exe to MO2 Tools; attached mode from MO2.
- Sideloading — open a plugin outside a load order; Spriggit import/export.
- Agentic integration (ACP/MCP); vector DB for semantic record lookup (+ FO4 wiki dump).
- Conflict resolution assistant — "Apply All Wins" batch copy to a patch plugin.
- Batch field edits (`PATCH /records` with multiple FormKeys); diff export (.txt/.html).
- Build Reachable Info (reference-graph reachability); circular leveled-list detection (recursive CTE).
- REFR spatial rendering (top-down cell map, DuckDB spatial); navmesh editing; previsibine generation.
- Asset handling — resolve loose/BA2 assets referenced by records; xEdit-style texture hashing.
- NIF editing in VS Code — PyFFI bridge (headless Python child process) or headless-Blender NIF plugin bridge.
