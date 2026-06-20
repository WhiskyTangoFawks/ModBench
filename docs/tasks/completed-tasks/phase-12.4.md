# Phase 12.4 — Struct Edit Verification & Fixes

Status: Completed

*Goal: verify the existing struct sub-row edit path works end-to-end, and fix any gaps found. Struct fields already produce `diff.children` and the merge logic exists — this phase confirms it and hardens it.*

---

## Background

Struct sub-row expansion was built and shipped in Phase 9.8 ("Struct sub-row display — `FieldDiff.Children`, expand/collapse toggle, per-sub-field conflict coloring and editing"). The backend generates `children` for struct fields in `BuildStructChildren()`. The frontend renders child `DiffRow` entries and has merge logic to patch a sub-field and commit the whole struct (RecordPanel.tsx:729-733). However, the edit/write path has not been explicitly verified end-to-end since 9.8 shipped.

Phase 12.3 (array child rows) depends on this same pattern working correctly — struct-typed array elements use the struct sub-row edit path. Verifying structs first reduces risk.

---

## Audit Checklist

Before writing any code, run the dev host and manually test:

- [ ] Open a record with a known struct field (e.g. `ObjectBounds` on any NPC — it has `X1`, `Y1`, `Z1`, `X2`, `Y2`, `Z2` sub-fields)
- [ ] Verify the parent struct row shows `{…}` and has a `▶` expand toggle
- [ ] Expand: sub-field rows appear, values align across plugin columns
- [ ] Edit mode: click into a sub-field cell on a mutable plugin — verify the correct input type renders (int inputs for `ObjectBounds` sub-fields)
- [ ] Edit a sub-field value and commit — verify:
  - The pending column for that sub-field row shows the new value (yellow highlight)
  - The pending column for unchanged sub-field rows is empty
  - The revert `↩` button appears on the sub-field row (correct — it reverts the whole struct column)
  - `GET /changes?formKey=...` returns one change with `field_path = "object_bounds"` and `new_value = {full struct JSON}`
- [ ] Revert the change — verify all sub-field rows return to disk state

---

## Likely Gaps to Fix

Based on code inspection, these are the most probable issues:

### Gap 1: Pending display for struct sub-field rows

`DiffRow` pending column lookup (RecordPanel.tsx:397-401):

```ts
const rawPending = override?.pendingFields?.[pendingLookupField];
const pendingValue = parentFieldName !== undefined
  ? (rawPending as Record<string, unknown> | undefined)?.[diff.fieldName]
  : rawPending;
```

This path assumes `rawPending` is a `Record<string, unknown>`. If the pending value is a `JsonElement` (object) rather than a pre-parsed JS object, the property lookup will return `undefined`. Verify the type coming from `GET /changes` is correctly parsed.

### Gap 2: `BuildStructChildren` skips all sub-fields with null values

`BuildStructChildren` line 142: `if (subValues.Values.All(v => v == null)) continue`. This is correct for display but may hide struct fields that are null in the master but set in an override. Low priority — verify behavior.

### Gap 3: `fieldMetaMap` on sub-field rows

`RecordPanel.tsx:716`: `fieldMetaMap[diff.fieldName]?.fields?.find(f => f.name === child.fieldName)` — this looks up sub-field metadata. Verify `fieldMetaMap` is populated from the compare response correctly and the `fields` array is present.

---

## Fixes

- [ ] Fix any gaps found during the audit above
- [ ] Add or update `FieldMetadata` type guard in the pending column lookup to handle `JsonElement` vs plain object
- [ ] Ensure `overrideMeta` is correctly passed to child `DiffRow` instances for struct sub-fields (currently uses `subFieldMeta` from `fieldMetaMap[diff.fieldName]?.fields`)

---

## Tests

### Webview

- [ ] Struct field with two sub-fields: editing sub-field A calls `onEdit` with `{ A: newValue, B: originalValue }` (B is preserved from disk)
- [ ] Pending sub-field A highlighted; sub-field B not highlighted
- [ ] Revert on sub-field row triggers `onRevert` with the parent struct's change ID (not a sub-field-level ID)

### Backend

- [ ] `BuildStructChildren` produces correct `FieldDiff` children for `ObjectBounds` on a test NPC fixture
- [ ] Struct sub-field edit round-trip: edit sub-field, save, re-index, read — sub-field value persisted correctly

---

## Proof

```text
Test Files  18 passed (18)
Tests  207 passed (207)
```

Commit: a1fbb5e
