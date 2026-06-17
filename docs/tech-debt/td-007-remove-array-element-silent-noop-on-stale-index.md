# TD-007: `RemoveArrayElement` Silently No-ops on a Stale/Out-of-Range Index

**Severity:** Low
**Area:** `EditOrchestrator.DeleteRecords` / `RemoveArrayElement` / `ParseArrayIndex`
**Introduced:** Phase 10.3 (TD-001 fix — element-scoped delete nullification)

## What's happening

[`RemoveArrayElement`](../../MEditService/MEditService.Core/Edits/EditOrchestrator.cs#L250-L256)
drops the element at `index` from a JSON array:

```csharp
private static JsonElement RemoveArrayElement(JsonElement array, int index)
{
    var items = array.EnumerateArray().ToList();
    if (index < 0 || index >= items.Count) return array;
    items.RemoveAt(index);
    return JsonSerializer.SerializeToElement(items);
}
```

When `index` is out of range, it returns the array **unchanged** rather than signaling that the
removal didn't happen. The caller in `DeleteRecords` doesn't check whether `newValue` differs from
`oldValue` — it stages a `field_edit` `GroupMember` unconditionally, so an unchanged array gets
staged and applied as if the dangling reference were removed.

## Impact

`index` comes from `ParseArrayIndex(fieldPath)`, where `fieldPath` is read from
`_query.GetReferences(formKey)` — a snapshot of the reference index taken before the nullification
loop runs. If the underlying record's array shrinks between that scan and the nullify step (e.g. a
concurrent pending edit, or a second `toNullify` entry for the same array already having removed an
earlier index — see TD-001's element-removal fix), the index can point past the current array's end.

**Concrete failure:** the dangling reference is neither removed nor flagged as unremovable — the
user sees a "perks → perks" edit in pending changes with `old_value == new_value`, gets no warning,
and the record they deleted is still referenced after save.

Low severity because the only known trigger today is the TD-001 multi-delete-same-array overwrite
case, which is fixed by [TD-001](td-001-delete-nullification-subpath.md)'s own follow-up to compute
all same-array removals from one read instead of independent reads. Once that's fixed, this no-op
path becomes effectively unreachable absent true concurrent mutation (a single-user local editor).

## Fix Plan

Make the no-op observable instead of silent:

1. Return `bool` (or a sentinel) from `RemoveArrayElement` indicating whether removal happened.
2. If removal didn't happen, either skip staging that `GroupMember` entirely, or fall back to the
   pre-TD-001 "nullify the whole field" behavior with a log warning — never stage a no-op edit.

## Related

- [TD-001](td-001-delete-nullification-subpath.md) — the element-removal fix this no-op path serves
- `MEditService/MEditService.Core/Edits/EditOrchestrator.cs` — `RemoveArrayElement`, `ParseArrayIndex`
