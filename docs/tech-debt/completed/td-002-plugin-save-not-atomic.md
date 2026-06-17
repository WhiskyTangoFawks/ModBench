# TD-002: Plugin Save Drain/Restore Transaction Lives in the HTTP Endpoint

**Severity:** Medium (correctness-bearing)
**Area:** `ChangeEndpoints.SavePlugin` / `DuckDbPendingChangeService.DrainForPlugin` + `Upsert` / `SessionManager.SavePlugin`
**Introduced:** Phase 4 (pending changes) + Phase 10 (group lifecycle), as save grew a failure path

## What's happening

The `POST /plugins/{plugin}/save` endpoint owns a three-step transaction by hand
([ChangeEndpoints.cs:227–252](../../MEditService/MEditService.Api/Endpoints/ChangeEndpoints.cs#L227-L252)):

1. **Drain** — `changes.DrainForPlugin(plugin)` removes the plugin's pending changes from the
   `pending_changes` table and returns them plus a `FormRefsByFormKey` lookup.
2. **Apply** — `await session.SavePlugin(plugin, drained.Changes)` writes to disk.
3. **Restore on failure** — if step 2 throws, the `catch` block re-stages every drained change by
   reconstructing a 9-argument `Upsert` call, rebuilding the `new_value`/`old_value` dictionaries
   from each `PendingChange`, and re-attaching the form-refs filtered by `StagedField`.

The invariant being enforced is **"a failed save must leave pending changes exactly as they were."**
That invariant has no module. It is open-coded in an HTTP handler's `catch`, where:

- It can only be exercised through a running server + a save that throws.
- It mirrors, by hand, the `Upsert` parameter shape and the `DrainResult` lookup structure — if
  either changes, the restore silently rebuilds the wrong thing.

```csharp
catch (Exception ex)
{
    logger.LogError(ex, "Failed to save plugin {Plugin} — re-queuing {Count} changes", ...);
    foreach (var c in drained.Changes)
    {
        var refsForField = drained.FormRefsByFormKey[c.FormKey]
            .Where(r => r.StagedField == c.FieldPath).ToList();
        changes.Upsert(c.FormKey, c.Plugin, c.RecordType,
            new Dictionary<string, JsonElement> { [c.FieldPath] = c.NewValue },
            c.Source, c.Description,
            new Dictionary<string, JsonElement> { [c.FieldPath] = c.OldValue },
            refsForField, c.ChangeType);
    }
    return Results.Problem(ex.Message);
}
```

## Impact

- **Untestable invariant.** "Pending changes survive a failed save" cannot be unit-tested without
  HTTP and a forced disk failure. There is no seam to inject a failing writer against.
- **Drift risk.** `Upsert` has 9 parameters and `group_id` semantics (see ADR-0017). The restore
  path reconstructs them positionally. A drained group change re-staged this way loses its
  `group_id` — the restore reconstructs a standalone edit, not a group member. Any save failure on
  a record carrying a Create/Delete group (Phase 10) would silently break group atomicity on
  restore.
- **Leaked structure.** The endpoint must know that `DrainResult.FormRefsByFormKey` is an
  `ILookup<string, PendingFormRef>` keyed by FormKey and filtered by `StagedField` — implementation
  detail of the pending-change store, surfaced in the API layer.

## Fix Plan

Make save one deep operation. Move drain + apply + restore-on-failure behind a single interface so
the endpoint calls it once and maps the result to a status code.

Two shapes, pick one during grilling:

**Option A — fold into `SessionManager.SavePlugin` (or a new `PluginSaver`).**
The method takes a plugin name, drains internally, applies, and on failure re-stages through the
same internal write path the drain used (no positional reconstruction). Returns `SaveResult`.

```csharp
// endpoint shrinks to:
var result = await saver.Save(decodedPlugin);   // drain+apply+restore inside
return result switch { ... };                    // map to status
```

**Option B — give `IPendingChangeService` a `RestoreDrained(DrainResult)` method.**
Smaller change: the endpoint still orchestrates, but restore stops reconstructing `Upsert` calls
by hand — the store knows how to put a `DrainResult` back, group_id intact.

Option A is the deeper fix (the whole transaction has one home); Option B closes the group_id bug
with less churn.

## Decisions to make before implementing

1. **Where does the drain/restore live — `SessionManager`, or a new `PluginSaver` in `Edits/`?**
   `SessionManager.SavePlugin` already exists and is the apply step; folding drain+restore in keeps
   one method but widens `SessionManager`'s job. A `PluginSaver` is a cleaner seam but a new type.
2. **Restore fidelity.** The restore must preserve `group_id`, `changed_at`, `source`, and `id`.
   Confirm `DrainForPlugin` returns enough to restore a group member exactly (it currently returns
   `PendingChange`, which does carry `GroupId` — verify it's round-tripped, since the current
   `catch` drops it).
3. **Should drain even happen before a save that might fail?** Alternative: copy-then-delete —
   apply from a read of pending changes, delete only on success. That removes the restore path
   entirely. Weigh against ADR-0017's table model.

## Related

- [ChangeEndpoints.cs:227–252](../../MEditService/MEditService.Api/Endpoints/ChangeEndpoints.cs#L227-L252) — `SavePlugin` endpoint
- `MEditService/MEditService.Core/Edits/DuckDbPendingChangeService.cs` — `DrainForPlugin`, `Upsert`, `DrainResult`
- `MEditService/MEditService.Core/Session/SessionManager.cs` — `SavePlugin`
- ADR-0017 — pending change model (`group_id`, DuckDB table)
- [TD-003](td-003-result-to-http-mapping-duplicated.md) — sibling: the endpoint's result→status mapping
