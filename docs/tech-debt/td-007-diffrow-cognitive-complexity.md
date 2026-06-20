# TD-007 — Reduce `DiffRow` cognitive complexity

## Problem

**S3776 — Cognitive complexity 26 (limit 15)**
`DiffRow` in `RecordPanel.tsx` scores 26 on SonarJS's cognitive complexity metric. The `!isGrandchild` condition added during Phase 12.4 raised it from 25 to 26 — this was the trigger, but the root cause is the function doing too much: it renders three structurally different column kinds (field-name cell, disk columns, pending columns), each with branching logic over four row archetypes (top-level, struct sub-field, array element, grandchild).

The main complexity drivers inside the `columns.map` render loop:

1. **Pending-value resolution** — `if (isArrayElement) / else if (isGrandchild || parentFieldName !== undefined) / else` with an inner `if (isGrandchild)` branch (4 paths, adds ~5 points)
2. **Disk-cell collapsed-vs-leaf rendering** — `if (hasChildren)` inside the column loop (2 paths)
3. **Revert-button condition** — `change && !isArrayElement && !isGrandchild` (2 extra conditions layered on top)
4. **Top-level row toggle button** — only present when `hasChildren && depth === 0`
5. **Cell-type dispatch in `renderCell`** — called from within `DiffRow` but lives outside it; still contributes to the reading burden

## Fix

Split `DiffRow` into focused sub-components:

1. **Extract `PendingCell`** — pulls out the entire pending column logic (rawPending lookup → pendingValue resolution via `pendingIfChanged` / `extractPendingElementValue` → hasPending → yellow style → revert button). Props: `diff`, `col`, `override`, `pendingChangeMap`, `isArrayElement`, `isGrandchild`, `overrideMeta`, `parentFieldName`, `parentFieldIndex`. Removes ~20 lines from `DiffRow`'s `columns.map`, dropping the revert-button nested condition entirely from the outer function.

2. **Extract `DiskCell`** — pulls out the disk column logic (collapsed label vs `renderCell` dispatch, `checkError` lookup). Props: `diff`, `o`, `meta`, `isExpanded`, `hasChildren`, `isArrayElement`, `isGrandchild`, `checkErrorFieldName`, `editMode`, `port`, `onOpen`, `onEdit`.

3. **`DiffRow` becomes a row skeleton** — renders the field-name `<td>` (with toggle button) and maps columns to `<DiskCell>` or `<PendingCell>`. The branch over `col.kind` stays but is the only top-level branch.

## Estimated complexity after fix

- `DiffRow`: ~3–4 points (one `hasChildren` check + one column-kind branch + toggle)
- `PendingCell`: ~6–7 points (3-way pending-value branch + hasPending guard + revert condition)
- `DiskCell`: ~4 points (hasChildren branch + checkError condition)

All three would be under the 15-point limit.

## Location

`medit-vscode/webview/src/RecordPanel.tsx` — `DiffRow` function (~line 445, ~120 lines long)

## Notes

- `pendingIfChanged` stays as a module-level helper; both `PendingCell` and `extractPendingElementValue` call it.
- The top-level asymmetry (top-level `else` branch skips `pendingIfChanged`) should be resolved during this refactor — either apply `pendingIfChanged` uniformly or document why top-level pending is intentionally never suppressed.
- No behaviour change expected; all existing `ArrayDiffRows.test.tsx` and `RecordPanel.test.tsx` suites should pass without modification.
