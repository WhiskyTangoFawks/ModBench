# TD-006 — Extract `PickChildWinner` to eliminate 3× winner-picking duplication

## Problem

The expression:
```csharp
records.Where(r => subValues.GetValueOrDefault(r.Plugin) != null).MaxBy(r => r.LoadOrderIndex)!
```
appears three times in `BuildArrayChildren` (sortable branch, index branch) and `BuildStructChildren`. A fourth variant (without the `!`) lives in `ComputeCellStates`. Any change to the winner-selection rule requires three edits and can silently diverge.

## Fix

Extract a `private static RecordDetail PickChildWinner(IReadOnlyList<RecordDetail> records, Dictionary<string, object?> subValues)` helper. All three call-sites collapse to one line. The `ComputeCellStates` variant is slightly different (nullable return, no `!`) so leave it separate or give it a distinct name.

## Location

`MEditService/MEditService.Core/Queries/ConflictClassifier.cs` — `BuildArrayChildren` (×2) and `BuildStructChildren` (×1)
