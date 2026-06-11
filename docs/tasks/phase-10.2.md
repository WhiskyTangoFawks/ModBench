# Phase 10.2 — New Record Creation

**Status: Not Started**

*Goal: replace `POST /records/{formKey}/copy-to/{targetPlugin}` with a unified `POST /plugins/{plugin}/records` endpoint that handles both blank creation and template-copy, with Mutagen's FormKey allocation happening at save time.*

*Depends on: Phase 10.1 (ChangeType on PendingChange).*

---

## Backend

### FormKey reservation

- [ ] Add `string ReserveFormKey(string plugin)` to `ISessionManager`
- [ ] Implement in `SessionManager`: on session load, read each writable plugin's Mutagen header `NextFormID` into a `Dictionary<string, uint>` held on the session; `ReserveFormKey` atomically increments the per-plugin counter under the existing lock and returns the FormKey string (e.g. `"001234:MyMod.esp"`)

### Orchestrator

- [ ] Add `CreateRecordResult CreateRecord(string plugin, string recordType, string? templateFormKey, string source)` to `IEditOrchestrator` and `EditOrchestrator`
- [ ] Logic:
  1. Validate plugin is mutable; validate `recordType` exists in schema
  2. Call `_session.ReserveFormKey(plugin)` → `newFormKey`
  3. Stage a `Create` pending change: `ChangeType="create"`, `FieldPath="$create"`, `OldValue=null`, `NewValue=null`
  4. If `templateFormKey` provided: fetch winner's fields via `_query.GetRecord(templateFormKey)` and stage as `FieldEdit` pending changes for `newFormKey` (reuse the field-copy logic from `CopyRecordTo`, retargeted to `newFormKey`)
  5. Return `new CreateRecordResult(newFormKey, stagedChanges)`
- [ ] Add `CreateRecordResult` DTO to `Queries/Models.cs`: `record CreateRecordResult(string FormKey, IReadOnlyList<PendingChange> Changes)`

### `PluginWriter` — Create code path

- [ ] When saving, detect `ChangeType == "create"` for a FormKey group: call `schema.AddNew!(mod, reservedFormKey)` using the `RecordTableSchema.AddNew` delegate, then apply any sibling `FieldEdit` changes on top via the existing `TryApplyField` loop

### `SchemaReflector` / `RecordTableSchema` additions

- [ ] Add `Func<ISetter, FormKey, IMajorRecord>? AddNew` to `RecordTableSchema`
- [ ] In `SchemaReflector.BuildSchema()`: reflect on the game-specific mutable mod type to find the `IGroup<T>` property whose element type matches the current record type; build and store a delegate `(mod, fk) => ((IGroup<T>)prop.GetValue(mod)!).AddNew(fk)`; leave null for excluded/unsupported types

### Endpoints

- [ ] Add `POST /plugins/{plugin}/records` with body `{ type: string, templateFormKey?: string }` → `CreateRecordResult`; errors: 404 (no session/plugin), 409 (immutable), 422 (unknown record type)
- [ ] Remove `POST /records/{formKey}/copy-to/{targetPlugin}` — **breaking change**: backend and extension must be updated together; an older extension against a newer backend will get 404 on copy-to

## Extension / Webview

- [ ] Regenerate API client: `npm run generate-api` after backend changes
- [ ] `SessionController` — replace `copyRecordTo()` with a call to `POST /plugins/{plugin}/records` (pass `templateFormKey`)
- [ ] `extension.ts` — update `mEdit.copyAsOverrideInto` handler to use new endpoint
- [ ] Add `mEdit.createBlankRecord` command: available on right-click of a plugin node (`viewItem == plugin`); prompts user to pick a record type via QuickPick (all types from session schema); calls `POST /plugins/{plugin}/records` without `templateFormKey`
- [ ] Register `mEdit.createBlankRecord` in `package.json` under `contributes.commands` and `view/item/context` (when `viewItem == plugin`)
- [ ] Add `mEdit.createBlankRecord` to `EXPECTED_COMMANDS`

## Tests

- [ ] `POST /plugins/{plugin}/records` without template stages a single `Create` pending change with `ChangeType="create"`
- [ ] `POST /plugins/{plugin}/records` with `templateFormKey` stages `Create` + field edits matching the template winner's fields
- [ ] Old `copy-to` endpoint returns 404

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
