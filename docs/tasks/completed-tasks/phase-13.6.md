# Phase 13.6 — VMAD Scalar-Array Editing

**Status: Complete** · Parent: [phase-13](phase-13.md) · Depends on: 13.5 · **Model: Sonnet** *(bounded full stack; mirrors Phase 12 generic array editing)*

*Goal: scalar-array VMAD properties (`ArrayOfObject`, `ArrayOfString`, `ArrayOfInt`, `ArrayOfFloat`, `ArrayOfBool`) are editable — add, remove, reorder, and edit elements — using the atomic-column pending model (ADR-0019).*

Full stack (backend apply + frontend) in one subphase; the array machinery is bounded and mirrors the generic array editing from Phase 12.

---

## Pending model (ADR-0019 atomic column)

Per ADR-0019, arrays are **atomic at column level**: one pending change per (property, plugin) holding the **full new array** as JSON. There is no per-element pending change (array indices have no stable identity).

- [ ] Field path: the same `VMAD\<ScriptName>\<PropertyName>` path as 13.4, but the value payload is the full array:
  - `ArrayOfInt` → `[1, 2, 3]`
  - `ArrayOfString` → `["a", "b"]`
  - `ArrayOfBool` → `[true, false]`
  - `ArrayOfFloat` → `[1.0, 2.5]`
  - `ArrayOfObject` → `[{ "formKey": ..., "alias": ... }, ...]`

## Backend apply — `PluginWriter.ApplyVmadField`

- [ ] Extend the 13.4 `ApplyVmadField` dispatch: for `Script*ListProperty`, clear the existing list and rebuild it from the JSON array, constructing the right element type (`ScriptObjectProperty` for ArrayOfObject elements, scalars otherwise).
- [ ] `ArrayOfObject` elements update `form_references` (each element FormKey). Route through the same VMAD form-ref extraction as 13.4's Object case.
- [ ] Re-index after save includes the rebuilt `vmad_property_list_items` rows.

## Frontend

Reuse the unified-tree array pattern from the generic grid (`ArrayRowGroup` / array child rows, `NewStructElementDialog` precedent for "add element"):

- [ ] In edit mode, a scalar-array property expands to per-element rows with a per-element edit widget (numeric/text/bool/FormKey picker by element type).
- [ ] Add-element and remove-element controls; reorder if the generic array UI supports it (parity with how generic arrays behave).
- [ ] On any element mutation, recompute the full array and stage it as the atomic column value (one pending change for the whole property), matching the generic array's atomic-column staging.
- [ ] Pending display: the whole property row reflects "pending" when its array differs; element rows show pending values. Revert clears the single pending change for the property.

---

## Tests

Backend (`dotnet test`):
- [ ] Saving an edited `ArrayOfInt` writes the new element sequence.
- [ ] Adding an element to `ArrayOfString` increases the written list length and re-indexes `vmad_property_list_items` correctly.
- [ ] Editing `ArrayOfObject` updates `form_references` for the new FormKeys.

Frontend (`npm run test:unit`):
- [ ] A scalar-array property expands to editable element rows in edit mode.
- [ ] Add/remove element restages the full array as one pending change.
- [ ] Revert clears the array pending change.

---

## Proof

Commits: `dbf0d1f` (implementation), `a131cd6` (mutation-covering tests)

```
dotnet test: Passed! — Failed: 0, Passed: 654, Total: 654
npm run test:unit: Tests 238 passed (238)
Stryker: No issues found (all mutants killed)
```
