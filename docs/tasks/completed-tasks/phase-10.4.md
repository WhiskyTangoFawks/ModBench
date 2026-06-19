# Phase 10.4 — Renumber FormID

**Status: Complete**

*Goal: stage a FormID change as an atomic ChangeGroup that updates the record's FormKey and all FormLink fields across editable plugins that reference it, blocking if any reference lives in an immutable plugin.*

*Depends on: Phase 11 (form_references), Phase 10.1 (ChangeGroup infrastructure).*

---

## Backend

### Orchestrator

- [ ] Add `RenumberResult Renumber(string formKey, uint newFormId, string plugin, string source)` to `IEditOrchestrator` and `EditOrchestrator`
- [ ] Logic:
  1. Validate plugin is mutable and record exists (`_query.GetRecordType(formKey)`)
  2. Build `newFormKey = $"{newFormId:X6}:{plugin}"`
  3. Check `_repository.GetReferences(formKey)` for references in immutable plugins → if any, return `RenumberResult.ImmutableReferences(blockers)`
  4. Validate `newFormId` is not already in use (query all record tables for a row with `form_key = newFormKey`) → return `RenumberResult.FormIdInUse` if taken
  5. Build `StageGroup("renumber", ...)` members:
     - One `Renumber` change: `ChangeType="renumber"`, `FieldPath="$renumber"`, `OldValue=oldFormKey`, `NewValue=newFormKey`
     - One `FieldEdit` change per reference field in editable plugins (set the FormLink value to `newFormKey`)
  6. Return `RenumberResult.Staged(changeGroup)`
- [ ] Add result types to `Edits/`: `RenumberResult { Staged(ChangeGroup), ImmutableReferences(IReadOnlyList<ReferenceResult>), FormIdInUse }`

### `PluginWriter` — Renumber code path

- [ ] When saving, detect `ChangeType == "renumber"` for a FormKey: read `OldValue`/`NewValue` from the change; obtain a `ModContext` for the old FormKey via the link cache; call `context.DuplicateIntoAsNewRecord(mod, newFormKey)` to add the renamed record to the mod's group; remove the old record entry from the group; call `mod.RemapLinks(new Dictionary<FormKey, FormKey> { { old, new } })` to cascade all references *within this plugin* (intra-plugin only — `FieldEdit` changes handle other plugins)
- [ ] **Intra/cross-plugin split:** Stage `FieldEdit` changes only for references in *other* editable plugins; `RemapLinks` handles all references within the plugin being saved. Without this split, references in the same plugin are double-updated.
- [ ] After save + re-index, `DuckDbRecordRepository.Index()` automatically rebuilds `form_references` for the affected plugin (existing pattern)

### Endpoints

- [ ] `POST /records/{formKey}/renumber` with body `{ newFormId: uint, plugin: string }` → 200: `ChangeGroup`; 409: immutable plugin holds a reference (body lists blockers); 422: `newFormId` already in use

## Extension / Webview

- [ ] `SessionController` — add `renumberRecord(formKey: string, newFormId: number, plugin: string)` method
- [ ] Record panel header area: FormID display becomes an editable field in edit mode; "Renumber" button stages the group; disabled if record belongs to an immutable plugin

## Tests

- [ ] Renumber returns 409 when an immutable plugin holds a reference
- [ ] Successful renumber stages a ChangeGroup with a `renumber` change + FieldEdit changes for all editable-plugin references
- [ ] Returns 422 when the requested new FormId is already in use in the load order

## Proof

Commit: `b895e59`

```text
Passed!  - Failed: 0, Passed: 544, Skipped: 0, Total: 544, Duration: 1 m 55 s
```
