# Phase 10.3 — Delete Records

**Status: ✓ Completed**

*Goal: safely stage deletion of one or more records as an atomic ChangeGroup, blocking if immutable plugins hold references, and nullifying intra-session FormLink fields that point to any deleted record.*

*Depends on: Phase 11 (form_references), Phase 10.1 (ChangeGroup infrastructure).*

---

## Backend

### Orchestrator

- [x] Add `DeleteRecordsResult DeleteRecords(IReadOnlyList<(string FormKey, string Plugin)> records, string source)` to `IEditOrchestrator` and `EditOrchestrator`
- [x] Logic:
  1. For each record: query `_repository.GetReferences(formKey)` and collect any references whose `Plugin` is immutable — these are blockers
  2. If any blockers: return `DeleteRecordsResult.Blocked(blockers)` — do not stage anything
  3. Check no pending group already active for any FormKey in the batch (via `_changes.GetGroupIdForRecord`); return `DeleteRecordsResult.BlockedByGroup` if so
  4. Identify intra-session FormLink fields pointing to any deleted record: call `_repository.GetReferences(formKey)` for each deleted record (not a raw `form_references` query — `GetReferences` unions committed + pending state so pending FieldEdits pointing to the deleted record are included); filter to editable-plugin sources — build nullification `FieldEdit` group members
  5. Call `_changes.StageGroup("delete", description, members)` where members are:
     - One `Delete` change per record: `ChangeType="delete"`, `FieldPath="$delete"`, null values
     - One `FieldEdit` change per nullified FormLink field
  6. Return `DeleteRecordsResult.Staged(changeGroup)`
- [x] Add result types to `Edits/`: `DeleteRecordsResult { Staged(ChangeGroup), Blocked(IReadOnlyList<BlockedReference>), BlockedByGroup }` — `BlockedByGroup`: one or more records in the batch already has a pending group change; revert that group before deleting
- [x] Add `BlockedReference` DTO to `Queries/Models.cs`: `record BlockedReference(string FormKey, string Plugin, string ReferencedFromPlugin)`

### `PluginWriter` — Delete code path

- [x] When saving, detect `ChangeType == "delete"` for a FormKey: remove the record from the mod's group via Mutagen group removal API

### Endpoints

- [x] `POST /records/delete` with body `{ records: [{ formKey: string, plugin: string }] }` → 200: `ChangeGroup`; 409 with `{ blockedBy: BlockedReference[] }` when cross-plugin immutable references exist

## Extension / Webview

- [x] `SessionController` — add `deleteRecords(records: { formKey: string; plugin: string }[])` method
- [x] Enable `canSelectMany: true` on the mEdit TreeView registration
- [x] `extension.ts` — register `mEdit.deleteRecord` command; handler receives `(item: RecordNode | undefined, allSelected: RecordNode[])`: if `item` is undefined (command palette with no selection), show error notification "Select one or more records in the tree first"; otherwise show `vscode.window.showWarningMessage` listing the N records being deleted (`EditorID [RecordType:FormID]`) with "Delete" / "Cancel" buttons; on confirm, call `SessionController.deleteRecords()` with all `(formKey, plugin)` pairs; on 409, show which plugins block the delete
- [x] Register `mEdit.deleteRecord` in `package.json` under `contributes.commands`, `view/item/context` (when `viewItem == record`), and `keybindings` (key: `Delete`, when: `focusedView == mEdit && viewItem == record`)
- [x] Add `mEdit.deleteRecord` to `EXPECTED_COMMANDS`

## Tests

- [x] `POST /records/delete` returns 409 with blocking records listed when an immutable plugin holds a reference
- [x] `POST /records/delete` with a valid batch stages one `ChangeGroup` covering all deletions + any nullification FieldEdits
- [x] Intra-session FormLink fields pointing to a deleted record are included as nullification changes in the group

## Proof

```text
dotnet test -v minimal
Passed!  - Failed:     0, Passed:   477, Skipped:     0, Total:   477, Duration: 1 m 43 s - MEditService.Tests.dll (net9.0)
```

```text
npm run test:unit
Test Files  15 passed (15)
     Tests  153 passed (153)
```

Mutation tests: clean (survivors triaged per repo mutation-triage convention).

Commit: ea5cd76 (fix flaky integration test suite — `xunit.runner.json` wasn't copied to output dir; found and fixed during validation). Feature work landed in f11b82d / e8cfdd1 / 26053fc.
