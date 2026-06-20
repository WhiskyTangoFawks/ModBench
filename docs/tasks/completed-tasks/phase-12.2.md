# Phase 12.2 — Array Child Rows (Backend)

**Status: Complete**

*Goal: the compare endpoint returns element-level child diffs for array fields, using xEdit's unified tree model — sorted arrays aligned by sort key across plugins, unsorted arrays aligned by position. See ADR-0019.*

---

## Background

`ConflictClassifier.BuildDiffs()` currently produces `children` only for struct fields (`meta.Fields != null`). Array fields return `children = null`, so the frontend renders them per-cell via `ArrayRowGroup`. This phase changes the backend to generate element-level child diffs for array fields too.

`BuildStructChildren()` currently skips nested arrays and nested structs inside struct sub-fields (`if (subField.IsArray || subField.Fields?.Count > 0) continue` at line 136). This guard is removed here — recursion now goes fully deep, bounded by `MaxArrayChildCount`.

---

## Backend — `ConflictClassifier`

### `MaxArrayChildCount` constant

- [ ] Add `private const int MaxArrayChildCount = 500;` to `ConflictClassifier`
- [ ] If an array would produce more children than this limit, emit `children = null` and log a warning:
  ```csharp
  _logger.LogWarning(
      "Array field {Field} on {FormKey} has {Count} elements across plugins — exceeding MaxArrayChildCount ({Max}), falling back to opaque display",
      fieldName, formKey, totalChildCount, MaxArrayChildCount);
  ```
  Inject `ILogger<ConflictClassifier>` if not already present.

### `BuildArrayChildren()` (new private static method)

- [ ] Signature:
  ```csharp
  private static List<FieldDiff>? BuildArrayChildren(
      FieldMetadata elementMeta,
      Dictionary<string, object?> parentValues,
      string masterPlugin,
      IReadOnlyList<RecordDetail> records,
      ILogger logger,
      int maxChildren)
  ```
- [ ] Parse each plugin's value as `JsonElement` array (null if absent or not an array)
- [ ] **Sorted arrays** (`elementMeta.IsSortable == true`): the sort key is the element string value itself (FormKey). Build a union of all unique sort-key strings across all plugins (ordered). Child count = union size. For each child, each plugin's value = the element at that sort key, or null if absent.
- [ ] **Unsorted arrays**: child count = max element count across all plugins. Align by index. Each plugin's value at child `i` = `array[i]` or null if the array is shorter.
- [ ] If child count exceeds `maxChildren`: return null after logging the warning.
- [ ] For each child, call `BuildChildFieldDiff()` (see below) to produce a `FieldDiff` with the element values per plugin, correct `CellStates`, and — if `elementMeta.Type == "struct"` — further `Children` via `BuildStructChildren()`.

### `BuildChildFieldDiff()` (new private static helper)

- [ ] Takes element index or sort key as `fieldName` (e.g. `"[0]"`, `"[1]"`, or the sort-key string for named elements)
- [ ] `values`: per-plugin element value (null if absent)
- [ ] `cellStates`: use `ComputeCellStates()` with appropriate master/winner logic — an element absent in a plugin is treated as null, not as `IdenticalToMaster`
- [ ] `children`: if `elementMeta.Type == "struct"` and `elementMeta.Fields != null`, call `BuildStructChildren(elementMeta.Fields, values, masterPlugin, records)`

### `BuildDiffs()` — call site

- [ ] In the `Select(fieldName => ...)` body, after setting `children` for struct fields, add the array case:
  ```csharp
  var children = meta?.Fields != null
      ? BuildStructChildren(meta.Fields, values, masterPlugin, records)
      : meta?.ElementType != null && meta.IsArray
          ? BuildArrayChildren(meta.ElementType, values, masterPlugin, records, _logger, MaxArrayChildCount)
          : null;
  ```

### `BuildStructChildren()` — remove depth guard

- [ ] Remove the `if (subField.IsArray || subField.Fields?.Count > 0) continue` guard (line 136)
- [ ] Replace with recursive calls: if `subField.IsArray && subField.ElementType != null` → call `BuildArrayChildren()`; if `subField.Fields != null` → call `BuildStructChildren()` recursively

---

## Tests

New file: `MEditService.Tests/Queries/ArrayChildDiffTests.cs`

- [ ] Sorted array: two plugins with overlapping keyword sets. Plugin A: `[KwdA, KwdB]`, Plugin B: `[KwdA, KwdC]`. `BuildDiffs` produces 3 child rows: `KwdA` (both), `KwdB` (A only, B null), `KwdC` (B only, A null)
- [ ] Unsorted array: plugin A has 3 elements, plugin B has 2. Children count = 3; plugin B's third child is null
- [ ] Array exceeding `MaxArrayChildCount`: returns null children; warning logged
- [ ] Struct-typed array element gets further struct sub-field children
- [ ] Re-index: no change to existing struct sub-field child generation

---

## Proof

```text
Passed!  - Failed: 0, Passed: 560, Skipped: 0, Total: 560, Duration: ~2m
```

Commit: see `phase-12.2-array-child-rows` branch.
