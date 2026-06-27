# Phase 16.2.4 — Frontend: create / copy / delete actions on tree nodes

**Status: Complete** · Parent: [phase-16.2](phase-16.2.md) · Depends on: 16.2.3 · **Model: Sonnet**

*Goal: context-menu create / copy-as-override / delete on cell, placed-group, and placed nodes,
wired to the backend.*

---

## Backend

- [x] New `POST /plugins/{plugin}/cells/{cellFormKey}/placed` (`ChangeEndpoints.cs`) — body
  `{ recordType, placementGroup, templateFormKey? }` → `orchestrator.CreatePlacedRecord(...)`; full
  `.Produces<CreateRecordResult>()` + `.ProducesProblem(...)` per the endpoint invariant. Copy/delete
  reuse existing `/records/{fk}/copy-to/{target}` and `/records/delete`.
- [x] `npm run generate-api`; committed `api.ts`.

## Frontend

- [x] `SessionController.createPlaced(...)` — mirrors `copyRecordTo`/`deleteRecords`
  (POST → ok → `refreshTree`). Copy/delete reuse existing controller methods.
- [x] Commands in `extension.ts`: `mEdit.createPlaced` (on placed-group node); `mEdit.copyAsOverrideInto`
  and `mEdit.deleteRecord` extended to also handle `PlacedNode` (union type, type-narrowed at call site).
  `PlacedGroupNode` gained `cellFormKey`; `PlacedNode` gained `plugin` — both threaded through
  `fetchCellGroups()` and `getChildren()`.
- [x] `package.json`: `mEdit.createPlaced` in `contributes.commands` + `view/item/context` with
  `when: viewItem == placedGroup-persistent || viewItem == placedGroup-temporary`; copy/delete
  context entries added for `viewItem == refr`.
- [x] Tree refreshes via existing `refreshTree()` after each op.

## Tests

- [x] `SessionController.test.ts`: 3 new tests for `createPlaced` (success/error/network failure),
  mirroring `deleteRecords` shape.
- [x] `mEdit.createPlaced` added to `EXPECTED_COMMANDS` (`test/integration/extension.test.ts`).
- [x] `npm run test:unit` (264 passing) + `npm run test:integration` (4 passing) + `npm run build` green.

## Proof

`dotnet test`: **740 passing** (RealGameLoadTests excluded — documented intermittent HTTP timeout
flakiness, unrelated to this sub-phase). `npm run test:unit`: **264 passing**. `npm run
test:integration`: **4 passing**. `npm run build`: clean. Commit: *see 16.2 batch commit*.
