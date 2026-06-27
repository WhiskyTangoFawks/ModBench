# Phase 16 — Per-Plugin Worldspace / Cell / Placed-Object Tree + CRUD

**Status: Complete.**

*Goal: WRLD/CELL/REFR render in their xEdit-style spatial hierarchy **per plugin** (what
that plugin declares — records and overrides, not a winner), and the standard record
operations (edit, create, copy-as-override, delete) work on placed objects.*

Design: placed objects (REFR/ACHR) are indexed as normal records; GRUP parentage lives in
`placement` / `cell_location` side tables populated by a reflection-based structural pass.
Reads/detail/CRUD/agent are uniform DuckDB queries. See [ADR-0023](../adr/0023-placed-objects-indexed-with-placement-side-tables.md)
and UI_SPEC §2.6.

## 16.1 — Index + read + display + edit (DONE)
- [x] Un-exclude `refr`/`achr` (`SchemaReflector`) → reflected record tables
- [x] `placement` / `cell_location` side tables (`TableDdlBuilder`) + indexes
- [x] `PlacementWalker` (game-agnostic) + `DuckDbRecordRepository.IndexPlacement` structural pass, incl. `pos_x/y/z`
- [x] `WorldspaceQueryService` + `GET /plugins/{plugin}/worldspaces`, `/worldspaces/{fk}/blocks`, `/cells/{fk}/references`, `/interior-cells`
- [x] Record detail for REFR works via existing `GET /records/{fk}` (refr indexed); field edits round-trip via existing pipeline (`ApplyFieldChanges` descends into cells)
- [x] Extension: per-plugin "Worldspaces" + "Interior Cells" nodes; WRLD → Block → Sub-block → Cell → Persistent/Temporary → placed; click opens editor; interior-cell pagination; spatial/placed types hidden from flat list
- [x] Tests: indexing pass, repository reads, block grouping, tree provider; `dotnet test` 700+/`npm run test:unit` 261 green; integration green

## 16.2 — Create / copy-as-override / delete placed objects (DONE)

Broken into four TDD-first sub-phases — see [phase-16.2.md](phase-16.2.md) (index + shared decisions).
The spike (cell-override + placed construction mechanism) is proven green; sub-phases build on it.

- [x] [16.2.1](phase-16.2.1.md) — `PluginWriter` copy/delete placed branches + typed link-cache wiring
- [x] [16.2.2](phase-16.2.2.md) — `pending_changes` placement columns + `GetPlacement` + `EditOrchestrator` placed paths (+ fixed pre-existing `PlacementWalker` overlay bug)
- [x] [16.2.3](phase-16.2.3.md) — walk overlay (surface pending created/copied, hide deletes)
- [x] [16.2.4](phase-16.2.4.md) — frontend create/copy/delete actions on cell/group/placed nodes

## Proof

*16.1 (read + display + edit): `dotnet test` **723 passing**; `npm run test:unit` **261
passing**; integration **4 passing**; `npm run build` clean. `/simplify` + `/code-review`
(high) completed, no confirmed bugs. Mutation baseline 74% (changed-files scope); all
survivors triaged (tests strengthened, dead code removed) — confirming re-run **deferred to a
manual run**, see [followup-mutation-workflow.md](followup-mutation-workflow.md). Commit:
`9c41ea4` + the triage commit on branch `phase-16-1-worldspace-tree`.*

*16.2 (create/copy/delete placed objects): `dotnet test` **740 passing** (RealGameLoadTests
excluded — intermittent HTTP timeout flakiness, unrelated); `npm run test:unit` **264
passing**; integration **4 passing**; `npm run build` clean. Batch commit pending mutation
triage.*
