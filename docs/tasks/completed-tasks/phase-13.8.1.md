# Phase 13.8.1 — VMAD Foundation + Add/Remove Property

**Status: Complete** · Parent: [phase-13.8](phase-13.8.md) · Depends on: 13.5 · **Model: Opus**

*Goal: Establish the `vmad_struct_op` structural-change foundation end-to-end and ship the first two ops — add a property to a script and remove a property. Later sub-phases (13.8.2/3/4) reuse this plumbing.*

See [phase-13.8.md](phase-13.8.md) for shared decisions and op-payload shapes.

---

## Backend

- [ ] `PendingChangeConstants.cs`: add `VmadStructOpChangeType = "vmad_struct_op"`.
- [ ] `PatchRecordRequest` (`ChangeEndpoints.cs`): add optional `string? ChangeType`; `PatchRecord` passes it to `StageEdit`.
- [ ] `EditOrchestrator.StageEdit`: add `changeType` param (default `field_edit`). When `vmad_struct_op`, branch to `StageVmadStructOp`:
  - read `op` from the field value; `add_property` requires `name`+`type` and the target script must exist (else a `StageEditResult` error);
  - skip scalar `CollectVmadReadOnlyFields`/`ValidateReferences`;
  - capture old value = existing property JSON (`FindVmadProperty`/`SerializeVmadOldValue`) or `null` for adds;
  - extract form-refs from the op's `value` for Object/ArrayOfObject;
  - `Upsert(..., changeType: VmadStructOpChangeType)`.
- [ ] `PluginWriter`: include `vmad_struct_op` changes in `ApplyFieldChanges`; `TryApplyField` routes them to `ApplyVmadStructOp`.
- [ ] `ApplyVmadStructOp`: resolve adapter + script; `add_property` builds the property via `BuildDefaultProperty(type)` + the existing per-type apply helpers (`ApplyObjectProperty`/`RebuildList`/`ApplyStructProperty`/`ApplyStructListProperty`/scalar), sets Name/Flags, adds to `script.Properties`, then `SortProperties`. `remove_property` removes by name.
- [ ] Added Object/ArrayOfObject properties register `form_references`.

## Frontend

- [ ] Add-property control on a script row (edit mode) → dialog reusing the `NewStructElementDialog` pattern (name + type + initial value; Object via inline FormKeyPicker).
- [ ] `RecordPanel.handleVmadStructOp(plugin, fieldPath, op)` → PATCH `{ plugin, fields: { [path]: op }, changeType: 'vmad_struct_op', source }`.
- [ ] Remove-property control on a property row → `{ op: 'remove_property' }`.
- [ ] Pending rendering in `VmadSection`: added property = new row in pending column (marked added); removed property = struck-through/marked.
- [ ] Value edits on a pending-added property re-issue `add_property` (merge rule), not `field_edit`.
- [ ] Revert clears the structural pending change.
- [ ] `npm run generate-api`; commit `api.ts`.

---

## Tests

Backend (`dotnet test`):
- [ ] add_property to an existing script → new property present, Properties sorted by name.
- [ ] add_property of an Object type → `form_references` row registered.
- [ ] remove_property → gone; siblings intact.
- [ ] add_property re-issued with a new value on same path → single pending op, latest value wins.
- [ ] Staging add_property when the named script doesn't exist → error result, nothing staged.

Frontend (`npm run test:unit`):
- [ ] Add-property dialog stages `vmad_struct_op` add with chosen type/name/value.
- [ ] Remove-property stages `{ op: 'remove_property' }`.
- [ ] Pending added row renders as added; removed row struck-through.
- [ ] Editing a pending-added property re-issues `add_property`.

---

## Proof

Commit `8c11851`. Backend `dotnet test`: 683 passed (incl. add/remove-property writer + staging tests). Frontend `npm run test:unit`: 250 passed; integration + build green.
