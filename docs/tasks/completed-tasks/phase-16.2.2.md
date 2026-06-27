# Phase 16.2.2 — Staging Plumbing: columns + GetPlacement + orchestrator paths

**Status: Complete** · Parent: [phase-16.2](phase-16.2.md) · Depends on: 16.2.1 · **Model: Opus**

*Goal: persist placement intent through `pending_changes`, add a placement lookup, and give
`EditOrchestrator` the placed create/copy/delete paths that stamp placement onto changes.*

---

## Backend

- [x] **`pending_changes` columns** (`DuckDbPendingChangeService.cs`). Added nullable `parent_cell` /
  `placement_group` to the DDL; extended the `INSERT`/`RETURNING` lists + appender bindings in `Upsert`
  and `StageGroup` from 12→14 columns; extended the **three** queries that feed `ReadChange` (`Upsert`
  RETURNING, `DoSelectChanges` SELECT, `DrainForPlugin` RETURNING) + `ReadChange` itself to cols 12-13.
  Added `string? parentCell = null, string? placementGroup = null` to `IPendingChangeService.Upsert` and
  to `GroupMember`.
- [x] **`GetPlacement` repo lookup** — declared on `IRecordReader`, implemented in
  `DuckDbRecordRepository` (`SELECT parent_cell, placement_group, pos_x/y/z FROM placement WHERE
  form_key=$1 AND plugin=$2`, reusing `PlacementRow`), stubbed `=> null` in `InMemoryRecordRepository`,
  and delegated through `IRecordQueryService`/`RecordQueryService` (the orchestrator's existing
  collaborator — no new ctor dependency).
- [x] **`EditOrchestrator` placed paths**:
  - `CreatePlacedRecord(...)` — shares a private `CreateRecordCore` with `CreateRecord`; stamps
    `parentCell`/`placementGroup` on the `$create` Upsert only.
  - `CopyRecordTo` — `GetPlacement(formKey, winner.Plugin)`; carries placement onto the copy change.
  - `DeleteRecords` — `GetPlacement(formKey, plugin)` per target; carries placement onto the delete
    `GroupMember`. Nullification logic unchanged.

### Pre-existing bug fixed (in scope)

- **`PlacementWalker` was broken on binary overlays** — production (`GameSession`) loads plugins via
  `ModFactory.ImportGetter` (overlay), whose group wrapper exposes records by being `IEnumerable`, not
  via the `"Records"` member the in-memory `Fallout4Group` uses. The walker reflected on `"Records"`, so
  it indexed **zero** placement/cell rows from overlay-loaded plugins (16.1 only ever tested the
  in-memory shape). Fixed by iterating the top-level group object directly (`Enumerate`), which works for
  both shapes. Regression test `Index_FromBinaryOverlay_PopulatesPlacementAndCellLocation` round-trips
  through disk to lock it in.

## Tests (`dotnet test`)

- [x] Round-trips placement through `pending_changes` (`Upsert`, `DrainForPlugin`, group read); non-placed
  changes default both columns null.
- [x] `GetPlacement` returns placement for an indexed placed ref; null for non-placed/absent.
- [x] Create/copy/delete each stage a change with correct placement; non-placed copy stages null.
- [x] `PlacementWalker` indexes placement/cell_location from a disk-loaded binary overlay.

## Proof

`dotnet build`: **0 warnings**; `dotnet format`: clean. `dotnet test`: **737 passing**, 2 failing —
both `RealGameLoadTests` (load the full real vanilla FO4 install over HTTP; client read-timeout/abort
under concurrent CPU load — the documented intermittent flakiness from 16.2.1, unrelated to this
sub-phase). Commit hash: *pending (await batch commit per 16.2 close-out workflow).*
