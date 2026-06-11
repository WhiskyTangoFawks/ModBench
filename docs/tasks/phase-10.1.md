# Phase 10.1 — PendingChange Model & ChangeGroup Infrastructure

**Status: Not Started**

*Goal: extend the pending-change data model with `ChangeType` and `GroupId`, introduce the `ChangeGroup` entity, and wire up the safety guards (`PATCH` / single-delete 409 on group-owned changes). No new lifecycle operations yet — just the plumbing that Phase 10.2–10.5 build on.*

---

## Backend

### Model changes

- [ ] Add `string ChangeType` to `PendingChange` — values: `"field_edit"` (existing default), `"create"`, `"delete"`, `"renumber"`
- [ ] Add `Guid? GroupId` to `PendingChange` — null for standalone field edits; set for grouped operations
- [ ] Add `ChangeGroup` record to `Edits/`: `record ChangeGroup(Guid Id, string Operation, string? Description, DateTime CreatedAt, int ChangeCount)`

### DuckDB schema

The `group_id` column already exists in `pending_changes`; only additions needed:

- [ ] Add `change_type VARCHAR NOT NULL DEFAULT 'field_edit'` to `pending_changes` DDL in `DuckDbPendingChangeService.EnsureTable()`
- [ ] Add `change_groups` table to `EnsureTable()`:
  ```sql
  CREATE TABLE IF NOT EXISTS change_groups (
      id          VARCHAR   PRIMARY KEY,
      operation   VARCHAR   NOT NULL,
      description VARCHAR,
      created_at  TIMESTAMP NOT NULL
  )
  ```
- [ ] Drop `change_groups` in `DropTable()`

### `IPendingChangeService` + `DuckDbPendingChangeService`

- [ ] `Upsert()` — include `change_type` in INSERT column list and RETURNING clause; update `ReadChange()` to read `change_type` and `group_id`
- [ ] `GetChanges(string? plugin, string? formKey, Guid? groupId)` — add optional `groupId` filter (breaking change to interface signature)
- [ ] `GetChangeGroups() → IReadOnlyList<ChangeGroup>` — LEFT JOIN `change_groups` with COUNT of matching `pending_changes WHERE group_id = id`
- [ ] Change `Revert(Guid changeId)` return type from `bool` to `RevertChangeResult`:
  ```csharp
  abstract record RevertChangeResult {
      record Reverted    : RevertChangeResult;
      record NotFound    : RevertChangeResult;
      record GroupOwned(Guid GroupId) : RevertChangeResult;
  }
  ```
- [ ] `bool RevertGroup(Guid groupId)` — atomically deletes the group row and all `pending_changes WHERE group_id = $id` in one transaction; returns false if group not found
- [ ] `Guid? GetGroupIdForRecord(string formKey, string plugin)` — `SELECT group_id FROM pending_changes WHERE form_key=$1 AND plugin=$2 AND group_id IS NOT NULL LIMIT 1`
- [ ] `ChangeGroup StageGroup(string operation, string? description, IReadOnlyList<GroupMember> members)` — INSERT into `change_groups`, then bulk INSERT all member changes with `group_id` set (for use by Phase 10.3/10.4); `GroupMember` is declared in `Edits/` as a shared type: `record GroupMember(string FormKey, string Plugin, string RecordType, string ChangeType, string FieldPath, JsonElement OldValue, JsonElement NewValue)`

### `StageEditResult` + `EditOrchestrator`

- [ ] Add `record BlockedByGroup(Guid GroupId) : StageEditResult`
- [ ] In `EditOrchestrator.StageEdit()`: after `ValidateEditContext`, call `_changes.GetGroupIdForRecord(formKey, plugin)`; if non-null return `new StageEditResult.BlockedByGroup(groupId)`

### Endpoints (`ChangeEndpoints.cs`)

- [ ] `GET /changes` — add `[FromQuery] Guid? groupId`; pass through to service
- [ ] `DELETE /changes/{changeId}` — handle `RevertChangeResult.GroupOwned` → 409 with detail naming the group ID
- [ ] `DELETE /changes/group/{groupId}` → 204 on success, 404 if not found
- [ ] `GET /change-groups` → `IReadOnlyList<ChangeGroup>`
- [ ] `PATCH /records/{formKey}` — handle `StageEditResult.BlockedByGroup` → 409

## Extension / Webview

- [ ] `webview/src/RecordPanel.tsx:529` — distinguish the two 409 cases: read the problem detail body; if the detail contains "group" (or a `BlockedByGroup` error code), show "This record has a pending group change — revert the group first"; otherwise show "Plugin is read-only"

## Tests

- [ ] `PATCH` on a record with a pending group change returns 409
- [ ] `DELETE /changes/{id}` on a group-owned change returns 409
- [ ] `DELETE /changes/group/{id}` reverts all changes in the group atomically
- [ ] `GET /changes?groupId={id}` returns only changes for that group
- [ ] `GET /change-groups` lists active groups with correct `changeCount`

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
