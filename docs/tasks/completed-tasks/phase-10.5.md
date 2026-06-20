# Phase 10.5 — Group Save Path

**Status: Complete**

*Goal: make ChangeGroups saveable as an atomic unit — draining and writing all plugins the group touches in one operation, with rollback on failure. The per-plugin save endpoint gains a guard so group changes cannot be saved piecemeal.*

*Depends on: Phase 10.1 (ChangeGroup infrastructure), Phase 10.2 (Create PluginWriter path), Phase 10.3 (Delete PluginWriter path), Phase 10.4 (Renumber PluginWriter path).*

---

## Backend

### `IPendingChangeService` additions

- [ ] `IReadOnlyList<PendingChange> DrainGroup(Guid groupId)` — delete the group row + all its changes and return them (same atomic pattern as `DrainForPlugin`)
- [ ] `IReadOnlyList<string> GetPluginsInGroup(Guid groupId)` — `SELECT DISTINCT plugin FROM pending_changes WHERE group_id = $1`

### `ISessionManager` + `SessionManager`

- [ ] `Task<IReadOnlyList<SaveResult>> SaveGroup(Guid groupId)`:
  1. Call `GetPluginsInGroup(groupId)` to identify affected plugins
  2. Call `DrainGroup(groupId)` to remove all changes atomically
  3. Group drained changes by plugin: `var byPlugin = drained.GroupBy(c => c.Plugin)`
  4. For each affected plugin, call `SavePlugin(plugin, byPlugin[plugin])` sequentially
  5. On any failure: re-queue all drained changes via `Upsert()` (preserving `group_id` and `change_type`), then rethrow
- [ ] `POST /plugins/{plugin}/save` — guard: if the plugin has any group-owned pending changes (any row with `group_id IS NOT NULL`), return 409 directing the caller to use `POST /change-groups/{groupId}/save` instead

### Endpoints (`ChangeEndpoints.cs`)

- [ ] Modify `POST /plugins/{plugin}/save` — add 409 guard for group-owned changes; update `.ProducesProblem(409)` annotation
- [ ] Add `POST /change-groups/{groupId}/save` → `IReadOnlyList<SaveResult>`; 404 if group not found

## Extension / Webview

- [ ] `SessionController` — add `saveGroup(groupId: string)` and `revertGroup(groupId: string)` methods
- [ ] Register a second VS Code tree view `mEditChangeGroups` in the mEdit view container (declared in `package.json` under `contributes.views`)
- [ ] `ChangeGroupsTreeProvider` — implements `TreeDataProvider<ChangeGroupNode>`; calls `GET /change-groups` on refresh; each node exposes inline tree item buttons for Save and Revert
- [ ] Title bar buttons: "Save All" (iterates all groups, calls `saveGroup` sequentially) and "Revert All" (iterates all groups, calls `revertGroup`); hidden when group list is empty
- [ ] Empty state: single informational node "No pending group changes."
- [ ] On save success: refresh both `mEditChangeGroups` and the plugin/record tree
- [ ] On partial save failure: show VS Code error notification naming which plugins saved and which failed; leave group row in tree with re-queued changes

## Tests

- [ ] `POST /plugins/{plugin}/save` returns 409 when the plugin has any group-owned pending changes
- [ ] `POST /change-groups/{groupId}/save` drains the group and saves all affected plugins
- [ ] On write failure during group save, all drained changes are re-queued with their original `group_id` intact
- [ ] After group save + re-index, `form_references` reflects the post-save state (delete: record's outbound references removed; renumber: new FormKey in references)

## Proof

Commit: `bbca39c`

```text
Passed!  - Failed: 0, Passed: 547, Skipped: 0, Total: 547, Duration: 1 m 57 s
```

```text
Test Files  16 passed (16)
     Tests  181 passed (181)
```
