# Phase 11 Tech Debt: Shared FormKey Traversal Utility

## Problem

Two methods encode the same three-case formKey-traversal logic over `ColumnSpec` columns:

| Method | File | Input type | Output type |
|--------|------|------------|-------------|
| `CollectFormRefs` | `DuckDbRecordRepository.cs` | `IMajorRecordGetter` (live Mutagen object) | `FormRef` (internal record) |
| `ExtractRefsForColumn` | `EditOrchestrator.cs` | `JsonElement` (serialised value) | `PendingFormRef` |

Both walk the same three structural cases in the same order:

1. `col.ApiType == "formKey"` — scalar formKey value
2. `col.ApiType == "array" && col.ElementType.Type == "formKey"` — array of formKey values, path `col.Name[{idx}]`
3. `col.ApiType == "array" && col.ElementType.Type == "struct"` — array of structs containing formKey subfields, path `col.Name[{idx}].{subField.Name}`

The guard strings (`"formKey"`, `"array"`, `"struct"`) and path-building expressions (`$"{col.Name}[{idx}]"`, `$"{col.Name}[{idx}].{subField.Name}"`) are character-for-character identical.

**Risk:** Adding a new structural case (e.g. a top-level struct column containing formKey subfields) requires two independent edits. A divergence where indexing sees a reference but staging doesn't (or vice versa) would produce silently wrong reference results.

## Goal

Extract a shared static utility `FormRefPathBuilder` in `MEditService.Core/Records/` (or a dedicated `Core/References/` folder) that performs the three-case dispatch and emits `(fieldPath, targetFormKey)` pairs via a delegate or `IEnumerable`, so both callers supply only the value-extraction logic for their own input type.

## Proposed Interface

```csharp
// In Core/Records/FormRefPathBuilder.cs
internal static class FormRefPathBuilder
{
    // Visitor delegate: called once per discovered formKey reference
    public delegate void RefVisitor(string fieldPath, string targetFormKey);

    // Walks col according to its ApiType, extracts values via getValue, calls visitor
    public static void Walk(
        ColumnSpec col,
        Func<ColumnSpec, object?> getValue,        // returns string (scalar) or IEnumerable (array)
        RefVisitor visitor);
}
```

`DuckDbRecordRepository.CollectFormRefs` would pass a `getValue` that calls `col.Extract(record)`.
`EditOrchestrator.ExtractRefsForColumn` would pass a `getValue` that reads from the `JsonElement`.

## Acceptance Criteria

- `CollectFormRefs` and `ExtractRefsForColumn` both delegate path-building to `FormRefPathBuilder.Walk`
- Adding a 4th structural case requires editing only `FormRefPathBuilder`
- All existing tests pass unchanged
- A new unit test covers `FormRefPathBuilder.Walk` for all three cases in isolation
