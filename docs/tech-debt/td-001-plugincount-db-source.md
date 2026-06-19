# TD-001 — pluginCount sourced from input, not post-commit DB state

## Problem

In `DuckDbPendingChangeService.StageGroup`, `actualCount` (the change count) is re-queried from the database after the commit so it reflects only rows actually belonging to the new group. `pluginCount`, added in Phase 10.5, is computed from the raw input `members` list before the commit:

```csharp
var pluginCount = members.Select(m => m.Plugin).Distinct(StringComparer.OrdinalIgnoreCase).Count();
```

The ON CONFLICT clause keeps the existing `group_id` when a row already belongs to another group:

```sql
group_id = COALESCE(pending_changes.group_id, excluded.group_id),
```

So a conflicting member's row stays attributed to its original group, but its plugin is still counted in `pluginCount`. The returned `ChangeGroup` DTO can overstate how many plugins the group actually touches.

## When it triggers

Two separate `StageGroup` calls that conflict on the same `(form_key, plugin, field_path)` triple — the second group's `pluginCount` includes the conflicting plugin even though zero of its changes live in the new group.

## Fix

Replace the in-memory `members.Select(...)` with a post-commit DB query matching the existing `actualCount` pattern:

```csharp
var pluginCountCmd = conn.CreateCommand();
pluginCountCmd.CommandText =
    "SELECT CAST(COUNT(DISTINCT plugin) AS INTEGER) FROM pending_changes WHERE group_id = $1";
pluginCountCmd.Parameters.Add(new DuckDBParameter { Value = groupId.ToString() });
var pluginCount = Convert.ToInt32(pluginCountCmd.ExecuteScalar()!, CultureInfo.InvariantCulture);
```

Alternatively, fold `COUNT(DISTINCT plugin)` into the existing `countCmd` query.
