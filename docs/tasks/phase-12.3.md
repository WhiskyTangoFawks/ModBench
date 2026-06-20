# Phase 12.3 — Array Child Rows (Frontend)

**Status: Completed**

*Goal: array fields display as expandable rows in the compare grid — element sub-rows aligned across plugin columns, pending changes visible at element granularity, revert on the parent row. `ArrayRowGroup` is retired from the compare grid. Depends on Phase 12.2.*

---

## Background

Phase 12.2 makes the backend return `diff.children` for array fields. This phase wires the frontend to consume those children, matching the struct expansion pattern already in place. See ADR-0019.

The pending display change is key for agentic review: element rows where the pending array value differs from the disk array value are highlighted yellow, making it immediately obvious which elements an agent changed. Only the parent row has a revert button.

---

## Extension / Webview

### `renderCell()` (`RecordPanel.tsx`)

- [ ] Remove the `ArrayRowGroup` branch for `meta.type === 'array'`. Replace with the same collapsed-state summary used for structs:
  ```tsx
  if (meta.type === 'array') {
    return <span style={{ opacity: 0.5 }}>{isExpanded ? null : `[${Array.isArray(value) ? value.length : '…'}]`}</span>;
  }
  ```
  The parent array row shows `[N]` when collapsed and nothing when expanded (children take over).

### `DiffRow` — pending column for array element rows

- [ ] Array element rows have `parentFieldName = diff.fieldName` (the column name, e.g. `"packages"`). The pending lookup already uses `pendingLookupField = parentFieldName ?? diff.fieldName` — this is correct.
- [ ] The pending value for an element row must be extracted from the parent pending array at the element's position. Add a helper `extractPendingElementValue(rawPending: unknown, childIndex: number | string): unknown`:
  - `rawPending` is the parent column's pending value (a JSON array)
  - For sorted arrays (sort key as fieldName string): find the element in the pending array whose sort-key matches `childIndex`
  - For unsorted arrays (numeric index as fieldName `"[0]"`, `"[1]"` etc.): parse the index integer, return `array[i]`
  - Returns `undefined` if the pending element equals the disk element (no highlight needed)
- [ ] Wire `extractPendingElementValue` into the pending column render path for rows with `depth > 0` and `parentFieldName` set

### Parent array row — revert button placement

- [ ] The revert `↩` button appears only on the parent array row (where `hasChildren === true` and `meta.type === 'array'`), not on element sub-rows
- [ ] Element sub-rows show yellow highlight if pending ≠ disk, but no revert button — the parent row's revert undoes the whole column atomically

### Expand state

- [ ] Array field names are added to `expandedStructs` toggle (same `Set<string>` used for structs) — no separate state needed

### Edit interaction for array element rows

- [ ] Element sub-rows are editable in edit mode. When the user edits element `i`:
  - Read the current pending array (or disk array if no pending change) for this plugin
  - Replace element `i` with the new value
  - Call `onEdit(plugin, parentFieldName, updatedArray)` — commits the whole column
- [ ] For element rows where `elementType.type === 'formKey'`: render `FormKeyCell`
- [ ] For element rows where `elementType.type` is a scalar: render `ScalarCell`
- [ ] For element rows where `elementType.type === 'struct'`: the element row itself has children (sub-field rows from phase 12.2); no cell edit at the element level — edit happens at the sub-field level via the existing struct sub-row edit path (merge sub-field → commit parent struct → onEdit with full updated array)

### `ArrayRowGroup` retirement

- [ ] `ArrayRowGroup.tsx` is no longer imported in `RecordPanel.tsx` or `renderCell()`. Delete the import. Do not delete the file yet — confirm via `npm run build` that it becomes dead code, then delete in the same commit.

---

## Tests

### Webview (`RecordPanel.test.tsx` or new `ArrayDiffRows.test.tsx`)

- [ ] Two plugins with `Keywords: [KwdA, KwdB]` and `Keywords: [KwdA, KwdC]` produce 3 child rows; plugin B's `KwdB` row is empty
- [ ] Parent array row shows `[2]` when collapsed
- [ ] Pending array value with element 1 changed: element 1 row is yellow-highlighted; element 0 row is not highlighted
- [ ] Revert button (`↩`) appears on parent row only, not on element rows
- [ ] Edit of element 1 FormKey: `onEdit` called with full updated array (element 0 unchanged, element 1 replaced)
- [ ] `ArrayRowGroup` is no longer rendered anywhere in the compare grid

---

## Proof

```text
Test Files  18 passed (18)
Tests  200 passed (200)
```

Commit: 80f3976 (pre-commit — changes staged, not yet committed)
