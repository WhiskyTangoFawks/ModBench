# Modbench — Roadmap

**Where work lives:** durable surface specs in [docs/specs/](docs/specs/); work items (PRDs and vertical-slice issues) on [GitHub Issues](https://github.com/WhiskyTangoFawks/mEdit/issues); completed phase specs (with proofs) archived in [docs/tasks/completed-tasks/](docs/tasks/completed-tasks/).

## Workflow

Per initiative: `/grill-with-docs` (sharpen the idea; updates CONTEXT.md/ADRs) → `/to-prd` (publish a PRD issue) → `/to-issues` (split into vertical-slice issues, `ready-for-agent`) → one fresh session per issue with `/implement` → when the slices ship, **fold the outcome into the surface spec**. Bugs via `/qa`; incoming external issues via `/triage` (once external users exist).

## Status

**Target game (v1): Fallout 4.** Multi-game architecture is in place (Phase M); other games need NuGet packages + wiring (#8).

Completed (specs + proofs in [completed-tasks/](docs/tasks/completed-tasks/)): phases 0–9.8 (core stack: plugin loading, DuckDB index, read/write API, extension, compare grid, conflict classification, SQL filters), 10.x (record lifecycle + ChangeGroups), 11 (Referenced By), 12.x (complex field display), 13.x (VMAD to TES5Edit parity), 16.x (worldspace/cell tree), A/B/B.1 (architecture + pending-change model), M (multi-game architecture), and modbench-1–6 (MO2-compatible mod manager: modlist, conflicts, hardlink deploy, editing integration, archive install).

## Open work

Snapshot index of open [GitHub Issues](https://github.com/WhiskyTangoFawks/mEdit/issues) (the source of truth) — migrated from the former phase files and the former local "Ideas" list. `wishlist` = wanted eventually, may never be actioned.

| Issue | Title | Label |
|---|---|---|
| [#1](https://github.com/WhiskyTangoFawks/mEdit/issues/1) | Phase 14 — Plugin File Management (compact FormIDs, ESL convert, masters, merge) | ready-for-agent |
| [#2](https://github.com/WhiskyTangoFawks/mEdit/issues/2) | Phase 15 — Scripting Engine (Python + SQL frontmatter) | ready-for-agent |
| [#3](https://github.com/WhiskyTangoFawks/mEdit/issues/3) | Phase 17 — Record Editor Column Interactions | ready-for-agent |
| [#4](https://github.com/WhiskyTangoFawks/mEdit/issues/4) | Phase B.2 — Pending-Overlay Read Views (prereq for #2) | ready-for-agent |
| [#5](https://github.com/WhiskyTangoFawks/mEdit/issues/5) | Modbench-7 — Nexus download integration | ready-for-agent |
| [#6](https://github.com/WhiskyTangoFawks/mEdit/issues/6) | Modbench-8 — Nexus update check | ready-for-agent |
| [#7](https://github.com/WhiskyTangoFawks/mEdit/issues/7) | Modbench-9 — Plugin load order | ready-for-agent |
| [#8](https://github.com/WhiskyTangoFawks/mEdit/issues/8) | Multi-Game Enablement | backlog epic (post-v1) |
| [#9](https://github.com/WhiskyTangoFawks/mEdit/issues/9) | Tech debt — Cross-platform backend publishing (Win+Linux; alpha blocker) | ready-for-agent |
| [#13](https://github.com/WhiskyTangoFawks/mEdit/issues/13) | Bug — ModListProvider.load() renders errors as an empty Loadout list | ready-for-agent |
| [#14](https://github.com/WhiskyTangoFawks/mEdit/issues/14) | Tech debt — extract listSeparators() query into IModlistSource | ready-for-agent |
| [#15](https://github.com/WhiskyTangoFawks/mEdit/issues/15) | Bug — modifyModlist read-modify-write is not serialized | ready-for-agent |
| [#16](https://github.com/WhiskyTangoFawks/mEdit/issues/16) | Tech debt — removeMod safe ordering + partial-failure surfacing | ready-for-agent |
| [#17](https://github.com/WhiskyTangoFawks/mEdit/issues/17) | Bug — parseModlist drops first mod on UTF-8 BOM | ready-for-agent |
| [#18](https://github.com/WhiskyTangoFawks/mEdit/issues/18) | Tech debt — cache session pluginMasters dict | ready-for-agent |
| [#19](https://github.com/WhiskyTangoFawks/mEdit/issues/19) | Injection classification — resolve spec contradiction then fold into ComputeConflictAll | needs-triage |
| [#20](https://github.com/WhiskyTangoFawks/mEdit/issues/20) | Initiative — Single-plugin sideloading workflow (open outside a load order + Spriggit import/export) | wishlist |
| [#21](https://github.com/WhiskyTangoFawks/mEdit/issues/21) | Initiative — Agent parity via VS Code LM API | needs-triage |
| [#22](https://github.com/WhiskyTangoFawks/mEdit/issues/22) | Batch operations on multi-selected records (copy, delete, accept/reject pending) | needs-triage |
| [#23](https://github.com/WhiskyTangoFawks/mEdit/issues/23) | Initiative — Multi-record compare view (records as columns) + copy-field-to-all | needs-triage |
| [#24](https://github.com/WhiskyTangoFawks/mEdit/issues/24) | Initiative — Plugin validation/diagnostics (warn-on-load + block-on-action) | needs-triage |
| [#25](https://github.com/WhiskyTangoFawks/mEdit/issues/25) | Wishlist — Smashed/Bashed-patch builder (element-level conflict merge) | wishlist |
| [#26](https://github.com/WhiskyTangoFawks/mEdit/issues/26) | Wishlist — REFR spatial rendering (top-down cell map) | wishlist |
| [#27](https://github.com/WhiskyTangoFawks/mEdit/issues/27) | Wishlist — Navmesh editing (scope-questioned) | wishlist |
| [#28](https://github.com/WhiskyTangoFawks/mEdit/issues/28) | Wishlist — Previsibine generation (likely out of scope) | wishlist |
| [#29](https://github.com/WhiskyTangoFawks/mEdit/issues/29) | Wishlist — NIF editing in VS Code (scope-questioned) | wishlist |
| [#30](https://github.com/WhiskyTangoFawks/mEdit/issues/30) | Asset handling (1/3) — decode material-swap texture hashes to readable names | needs-triage |
| [#31](https://github.com/WhiskyTangoFawks/mEdit/issues/31) | Asset handling (2/3) — parse BA2 archives for inter-archive conflict detection | needs-triage |
| [#32](https://github.com/WhiskyTangoFawks/mEdit/issues/32) | Asset handling (3/3) — report missing referenced assets (advisory) | needs-triage |
| [#33](https://github.com/WhiskyTangoFawks/mEdit/issues/33) | Wishlist — Load a Vortex modlist (read-only IModlistSource adapter) | wishlist |
| [#34](https://github.com/WhiskyTangoFawks/mEdit/issues/34) | Wishlist — Load multiple versions of the same plugin (shadowed copies) for delta comparison | wishlist |

## Planned initiatives (each starts as a `/grill-with-docs` → `/to-prd` session)

Seeded from the [MO2/Vortex feature inventory](docs/research/mod-manager-feature-inventory.md):

- **Downloads surface v1** — queue UI shape resolved ([ADR-0027](docs/adr/0027-mo2-surfaces-map-to-native-vscode-views.md): editor-tab webview + status-bar item); grill [docs/specs/downloads.md](docs/specs/downloads.md)'s remaining open questions (downloads directory, retention), then build; may absorb or supersede #5/#6.
- **Plugins / load-order surface** — resolved ([ADR-0027](docs/adr/0027-mo2-surfaces-map-to-native-vscode-views.md)): own Mod-Management sidebar view ([docs/specs/plugins.md](docs/specs/plugins.md)), stacked with Mods, not part of mEdit; dependency-only auto-sort, not a LOOT masterlist. Implementation tracked in #7.
- **FOMOD installers** — currently detect-and-flag only; a full `ModuleConfig.xml` installer is its own initiative.
- **Overwrite folder UX** — surface to reassign/discard files collected on purge.
- **Alpha readiness** — cross-platform packaging (#9), MO2 round-trip fidelity corpus, onboarding for the first external super-users.
