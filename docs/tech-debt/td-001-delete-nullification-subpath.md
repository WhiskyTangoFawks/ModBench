# TD-001: Delete Nullification Wipes Entire Array Field Instead of Target Element

**Severity:** Medium  
**Area:** `EditOrchestrator.DeleteRecords` / `FormRefPathBuilder` / `PluginWriter.TryApplyField`  
**Introduced:** Phase 10.3 (delete records)

## What's happening

`FormRefPathBuilder.Walk` indexes FormKey references at three path granularities:

| Case | Example path stored in `form_references` |
|------|------------------------------------------|
| Scalar field | `race` |
| Array of FormKeys | `keywords[2]` |
| FormKey inside struct-in-array | `perks[0].perk` |

When `DeleteRecords` stages nullification changes for records that reference a deleted record,
it calls `TopLevelFieldName(fieldPath)` to strip index/subfield suffixes before creating the
`GroupMember`. The result:

- `race` → `race` ✓ (scalar, correct)
- `keywords[2]` → `keywords` ✗ (wipes entire keywords array)
- `perks[0].perk` → `perks` ✗ (wipes entire perks array)

`PluginWriter.TryApplyField` then looks up `schema.RecordColumns.FirstOrDefault(c => c.Name == change.FieldPath)`
and writes `null` over the whole top-level column.

## Impact

Affects any delete where the referencing record has an **array** or **struct-in-array** FormKey field.
In FO4 this is extremely common:

- NPC perks (`perks[n].perk`)
- Container items (`items[n].item`)
- Keywords arrays (`keywords[n]`)
- Leveled list entries
- Faction memberships

**Concrete failure:** Delete NPC `A`. NPC `B` has `perks = [{perk: A_FormKey, rank: 1}, {perk: OtherPerk, rank: 2}]`.
The staged nullification wipes the entire `perks` field on `B`, destroying the `OtherPerk` entry.

The over-wide null is visible in the pending changes view (user sees "perks → null"), but the
confirmation prompt says "Delete record A?" — the user doesn't know perks will be fully wiped.

## Fix Plan

**All changes are in `EditOrchestrator.cs` only — `PluginWriter` needs no changes.**

For sub-path cases (`fieldPath.Contains('[') || fieldPath.Contains('.')`), instead of staging
`null` for the top-level field, read the current array JSON and patch only the affected element:

```csharp
foreach (var (sourceFormKey, sourcePlugin, fieldPath, recordType) in toNullify)
{
    string stagedFieldPath;
    JsonElement newValue;

    if (fieldPath.IndexOfAny(['.', '[']) >= 0)
    {
        // Sub-path: patch the specific element to null, stage the whole field.
        var topLevel = TopLevelFieldName(fieldPath);
        var currentRecord = _query.GetRecordForPlugin(sourceFormKey, sourcePlugin);
        var currentField = currentRecord?.Fields.FirstOrDefault(fv => fv.Metadata.Name == topLevel);
        newValue = PatchSubPath(currentField?.Value, fieldPath) 
                   ?? PendingChangeConstants.NullElement;
        stagedFieldPath = topLevel;
    }
    else
    {
        // Scalar field: null the whole thing (existing correct behavior).
        stagedFieldPath = fieldPath;
        var currentRecord = _query.GetRecordForPlugin(sourceFormKey, sourcePlugin);
        var currentField = currentRecord?.Fields.FirstOrDefault(fv => fv.Metadata.Name == fieldPath);
        newValue = currentField != null 
                   ? JsonSerializer.SerializeToElement(currentField.Value) 
                   : PendingChangeConstants.NullElement;
    }
    // ... add GroupMember with stagedFieldPath / newValue
}
```

`PatchSubPath(JsonElement? root, string subPath)` needs to:
1. Parse the bracket/dot path (e.g., `perks[0].perk`)
2. Navigate to the array element
3. Set the relevant sub-field (or the element itself) to `null`
4. Return the modified root as a `JsonElement`

Because `System.Text.Json` is read-only, this requires round-tripping through `JsonNode`:

```csharp
private static JsonElement? PatchSubPath(object? root, string subPath)
{
    // subPath is like "keywords[2]" or "perks[0].perk"
    // 1. Deserialize root to JsonNode
    // 2. Navigate by index / property name
    // 3. Set node to null
    // 4. Serialize back to JsonElement
}
```

## Decisions to make before implementing

1. **Null the element or remove it?**  
   `keywords[2] = null` leaves a null slot in the array. `keywords.RemoveAt(2)` collapses the array.
   xEdit removes the entry. **Recommendation: remove the slot** so the array stays clean.

2. **What if the sub-path no longer exists?** (race condition between indexing and delete)  
   Skip gracefully — don't stage a nullification for a ref that's already gone.

3. **Re-index after staging?**  
   The `pending_form_references` table is updated when changes are applied via `StageEdit`.
   Nullification changes should suppress the old reference entry — verify the `GetReferences` SQL
   already excludes pending-changed fields (`NOT EXISTS ... OR fr.field_path LIKE pc.field_path || '[%'`).
   Confirmed: the query already excludes sub-paths under a staged top-level field (line 409-411 of
   `DuckDbRecordRepository.cs`). After staging `keywords = null`, `keywords[n]` references are
   suppressed. This still holds with the element-removal fix.

## Related

- `MEditService/MEditService.Core/Edits/EditOrchestrator.cs` — `DeleteRecords` + `TopLevelFieldName`
- `MEditService/MEditService.Core/Records/FormRefPathBuilder.cs` — path generation
- `MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs:398` — `GetReferences` SQL
- `MEditService/MEditService.Core/Edits/PluginWriter.cs` — `TryApplyField` (no changes needed)
