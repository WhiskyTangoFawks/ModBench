# TD-005 — Reduce `BuildArrayChildren` cognitive complexity and fix O(n×m) sorted scan

## Problems

**S3776 — Cognitive complexity 37 (limit 15)**
`BuildArrayChildren` in `ConflictClassifier.cs` scores 37 on SonarQube's cognitive complexity metric. The root cause is two large branches (`IsSortable` / index-based) with nested lambdas inside a method that already has local functions (`MakeChild`, `WarnTooLarge`).

**O(n×m) sorted-branch key lookup**
In the sorted branch, for each key in `union`, the lambda calls `EnumerateArray()` on every plugin's array to find the element by string match. With `u` unique keys and `p` plugins each holding up to `e` elements, this is O(u × p × e). At `MaxArrayChildCount = 500`, that's up to 250,000+ iterations per field.

## Fix

1. Extract the sorted-branch body into `BuildSortedArrayChildren(...)` and the index-branch body into `BuildIndexedArrayChildren(...)`. Both call `MakeChild` (which can become a private static with explicit parameters). `BuildArrayChildren` becomes a 5-line router.
2. In the sorted branch, build an upfront `Dictionary<string, Dictionary<string, JsonElement>>` (one `EnumerateArray` pass per plugin), then look up keys in O(1). Replaces the inner `EnumerateArray().Where(...).FirstOrDefault()` in the `ToDictionary` projection.

## Location

`MEditService/MEditService.Core/Queries/ConflictClassifier.cs` — `BuildArrayChildren` method (~line 138)
