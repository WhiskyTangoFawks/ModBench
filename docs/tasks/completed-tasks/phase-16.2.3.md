# Phase 16.2.3 — Walk Overlay: surface pending placed refs, hide pending deletes

**Status: Complete** · Parent: [phase-16.2](phase-16.2.md) · Depends on: 16.2.2 · **Model: Sonnet**

*Goal: `GetCellReferences` reflects staged work — pending-created/copied refs appear under their
target cell; pending-deleted refs are hidden — mirroring the existing flat-list overlay.*

---

## Backend

- [x] Overlay pending changes onto `GetCellReferences` (`WorldspaceQueryService.cs` →
  `DuckDbRecordRepository.cs` ~778). The overlay belongs in `WorldspaceQueryService` (it can mirror
  `RecordQueryService`'s `_changes` access), keeping the repo query pure committed-data.
  - **Include** pending-created/copied placed refs whose `parent_cell` matches (like
    `RecordQueryService.GetRecords` appending `GetStagedFormKeys`), grouped persistent/temporary by
    `placement_group` from the change.
  - **Exclude** pending-deleted FormKeys (like the `NOT EXISTS (… pending_changes …)` filter in
    `GetReferences` ~681).

## Tests (`dotnet test`, `WorldspaceQueryServiceTests`)

- [x] Pending-created ref appears under its cell in the right group.
- [x] Pending-deleted ref is hidden.
- [x] Copied ref appears under the target cell.

## Proof

Commit `d36c16f`. `dotnet test`: Passed 742, Failed 0, Total 742 (8 WorldspaceQueryService tests).
