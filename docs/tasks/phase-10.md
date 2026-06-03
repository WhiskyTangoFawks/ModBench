# Phase 10 — Record Lifecycle Operations

**Status: Not Started**

*Goal: full create / delete / renumber lifecycle for records, with cascading safety checks and atomic rollback.*

## Pending change model changes
- [ ] Add `ChangeType` enum to `PendingChange`: `FieldEdit | Create | Delete` — `FieldEdit` is the current behavior; `Create` and `Delete` have no meaningful `FieldPath`/`OldValue`/`NewValue` and must be handled separately in `PluginWriter` and `PendingChangeService`
- [ ] Add `GroupId: Guid?` to `PendingChange` — `null` for standalone field edits, set for grouped operations (delete, renumber); included in all `GET /changes` responses so the UI can discover the group from any individual change
- [ ] Add `ChangeGroup` entity `{ Id, Operation, Description, CreatedAt }` tracked in `PendingChangeService`
- [ ] `PATCH /records/{formKey}` returns 409 if the record has any pending change in a group; error detail names the group — user must commit or revert the group first
- [ ] `DELETE /changes/{changeId}` returns 409 if the change belongs to a group — must use `DELETE /changes/group/{groupId}` instead
- [ ] `DELETE /changes/group/{groupId}` — atomically reverts every change in the group
- [ ] Edit-not-stack semantics: `PATCH /records/{formKey}` upserts into the existing `PendingChange` for the same `(FormKey, Plugin, FieldPath)` — no duplicate field entries; standalone edits can be freely re-edited

## ChangeGroup access
- [ ] `GET /changes?groupId={id}` — extend existing `GET /changes` with a `groupId` filter; returns all `PendingChange` records in the group
- [ ] `GET /change-groups` — list all active `ChangeGroup` records `{ id, operation, description, createdAt, changeCount }`; gives the UI a summary of in-flight multi-record operations without scanning individual changes

## New record
- [ ] `POST /plugins/{plugin}/records` with body `{ type: string, templateFormKey?: string }` — creates a blank record of the given type, or copies from template if `templateFormKey` is provided
- [ ] Stages as standalone pending changes (single record, no group needed)
- [ ] Supersedes `POST /records/{formKey}/copy-to/{targetPlugin}`; remove old endpoint

## Delete records
- [ ] **Prerequisite:** `form_references` table from Phase 11
- [ ] `POST /records/delete` with body `{ records: [{ formKey: string, plugin: string }] }` — batch; stages a single `ChangeGroup` covering all deletions + nullification of intra-plugin FormLink fields pointing to any deleted record
- [ ] Returns 409 if any record in the batch is referenced by another plugin or an immutable plugin; response body lists which records blocked the operation
- [ ] Returns 409 if a pending group is already active for any FormKey in the batch

## Renumber FormID
- [ ] **Prerequisite:** `form_references` table from Phase 11
- [ ] `POST /records/{formKey}/renumber` with body `{ newFormId: uint, plugin: string }`
- [ ] Returns 409 if any references are in immutable plugins (cannot update them)
- [ ] Stages a `ChangeGroup`: FormKey field update on the record + all reference field updates across editable plugins

## Save path
- [ ] `POST /plugins/{plugin}/save` returns 409 if any group it would drain spans multiple plugins — the caller must use the group save endpoint instead
- [ ] `POST /change-groups/{groupId}/save` — saves all plugins touched by the group atomically: drain the group, write each plugin via `PluginWriter`, re-index all affected plugins; fails as a unit if any write fails
- [ ] `PluginWriter`: add `Create` code path — call Mutagen record creation API, then apply field changes on top
- [ ] `PluginWriter`: add `Delete` code path — call Mutagen record removal API
- [ ] `PluginWriter`: add `Renumber` code path — change the FormKey in Mutagen (distinct from a field edit)
- [ ] Re-index after renumber must rebuild `form_references` rows for the affected FormKey (old rows removed, new rows inserted)
- [ ] **Known gap:** pending `Create` records are not visible in `GET /records` or the tree until after save + re-index; accepted for now, can be addressed later with a pending-creations overlay

## Tests
- [ ] `PATCH` on a record with a pending group change returns 409
- [ ] `DELETE /changes/{id}` on a group-owned change returns 409
- [ ] `DELETE /changes/group/{id}` reverts all changes in the group atomically
- [ ] `GET /changes?groupId={id}` returns only the changes for that group
- [ ] `GET /change-groups` lists active groups with correct `changeCount`
- [ ] `POST /plugins/{plugin}/records` without template creates a blank record pending change
- [ ] `POST /plugins/{plugin}/records` with `templateFormKey` stages a copy (same behavior as old copy-to)
- [ ] `POST /records/delete` returns 409 with blocking records listed when external references exist
- [ ] `POST /records/delete` with a valid batch stages one `ChangeGroup` covering all records
- [ ] Renumber returns 409 when an immutable plugin holds a reference
- [ ] Successful renumber stages changes for the record and all referencing editable-plugin fields

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
