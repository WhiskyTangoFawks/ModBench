# Phase 13.5 — VMAD Scalar Editing (Frontend)

**Status: Not Started** · Parent: [phase-13](phase-13.md) · Depends on: 13.3, 13.4 · **Model: Sonnet** *(reuses existing widgets + `pendingChangeMap` infra; low novelty)*

*Goal: in edit mode, VMAD scalar properties (Bool/Int/Float/String/Object) show edit widgets; edits stage as pending changes via the 13.4 synthetic-path contract; the pending column and revert work for VMAD rows.*

---

## Edit widgets

In the `VmadSection` from 13.3, when `editMode` is true and the property type is an editable scalar, render the same widgets the generic grid uses, reused from [RecordPanel.tsx](../../medit-vscode/webview/src/RecordPanel.tsx):

- [ ] Bool → checkbox / boolean control (reuse `ScalarCell`'s bool handling or `FlagCell` pattern as appropriate).
- [ ] Int / Float → numeric `ScalarCell`.
- [ ] String → text `ScalarCell`.
- [ ] Object → `FormKeyCell` / `FormKeyPicker` (FormKey link + picker), plus an alias input. Reuse the existing picker so validation/`checkError` plumbing carries over.
- [ ] Variable / ArrayOfVariable → render read-only placeholder even in edit mode (no widget).
- [ ] Scalar arrays and structs → still read-only here (their editing is 13.6 / 13.7); render as in 13.3.

## Staging

- [ ] On commit, build the synthetic VMAD field path `VMAD\<ScriptName>\<PropertyName>` and the per-type value payload exactly as specified in 13.4, and stage through the existing edit/PATCH path (the same `onEdit` / stage call the generic grid uses). The field map is `{ "<vmadPath>": <valueJson> }`.
- [ ] Object value payload: `{ "formKey": ..., "alias": ... }` per 13.4.

## Pending column & revert

- [ ] When a VMAD property has a pending change, render the pending value in the pending column (reuse `pendingIfChanged` / the pending-column rendering used by `DiffRow`), keyed by the VMAD field path.
- [ ] Revert on a VMAD row removes the pending change for that VMAD field path (reuse `onRevert`).
- [ ] Edited-but-unsaved VMAD cells get the same "dirty" styling as generic edited cells.

> Keep the VMAD pending lookup keyed on the synthetic path so it shares the existing `pendingChangeMap` infrastructure rather than a parallel store.

---

## Tests (`npm run test:unit`)

- [ ] In edit mode, a Bool property renders a checkbox; toggling it stages a change with the correct `VMAD\...` path and boolean payload.
- [ ] An Int/String property edit stages the correct path + value.
- [ ] An Object property edit via the picker stages `{ formKey, alias }`.
- [ ] A pending VMAD edit shows in the pending column; revert clears it.
- [ ] Variable / scalar-array / struct properties show no scalar edit widget in edit mode.

---

## Proof

*To be filled in on completion. Paste `npm run test:unit` output and commit hash.*
