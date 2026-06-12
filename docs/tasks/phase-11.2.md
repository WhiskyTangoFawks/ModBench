# Phase 11.2 — `GetReferences` Repository Method & API Endpoint

**Status: Complete**

*Goal: expose reference data through a typed repository method and a REST endpoint. `GetReferences()` unions committed rows from `form_references` with in-flight pending changes so that Phase 10.3 (delete safety) and Phase 10.4 (renumber cascade) see accurate reference state without waiting for a save.*

*Depends on: Phase 11.1 (`form_references` table populated during indexing).*

---

## Backend

### DTO — `Queries/Models.cs`

- [ ] Add `record ReferenceResult(string FormKey, string Plugin, string FieldPath, string RecordType)` to `MEditService.Core/Queries/Models.cs`

### `IRecordReader`

- [ ] Add `IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey)` to `MEditService.Core/Records/IRecordReader.cs`

### `DuckDbRecordRepository`

`pending_changes` and `form_references` share the same DuckDB connection (the pending-change service receives `repository.Connection` via `OnSessionLoaded`), so `GetReferences()` can query both tables in a single SQL statement.

`new_value` in `pending_changes` stores raw JSON: a scalar FormKey is stored as a JSON string `"XXXXXX:Plugin.esp"` (with surrounding quotes); an array field is `["...","..."]`; a struct array is `[{"field":"..."}]`. Searching for `%"<formKey>"%` via LIKE covers all three shapes.

- [ ] Implement `GetReferences(string targetFormKey)` using the following query (bind `$1 = targetFormKey`, `$2 = $"%\"{targetFormKey}\"%"`):

  ```sql
  -- Committed references, minus any whose column has a pending change
  -- (pending state is authoritative for any edited column)
  SELECT source_form_key, source_plugin, field_path, record_type
  FROM form_references
  WHERE target_form_key = $1
    AND NOT EXISTS (
      SELECT 1 FROM pending_changes pc
      WHERE pc.form_key = source_form_key
        AND pc.plugin   = source_plugin
        AND (
          field_path = pc.field_path           -- direct field match
          OR field_path LIKE pc.field_path || '[%'  -- array element under this column
        )
    )

  UNION ALL

  -- Pending state: field edits whose new_value now contains the target FormKey
  SELECT form_key, plugin, field_path, record_type
  FROM pending_changes
  WHERE new_value LIKE $2
  ```

  Notes:
  - **Pending removal** (user nulled a FormKey field): `NOT EXISTS` suppresses the committed row; second leg doesn't match `null`. Net: reference disappears. ✓
  - **Pending addition** (user set a previously-null field to a FormKey): no committed row; second leg matches. Net: reference appears. ✓
  - **Partial array edit** (user edited an array column that still contains the target FormKey): committed element-level rows for that column are suppressed by `NOT EXISTS`; the second leg picks up the column-level pending row as the authoritative reference. No duplicate. ✓
  - **Phase 12 note**: when `pending_changes` is refactored to element-level granularity, the `LIKE field_path || '[%'` workaround and the column-level LIKE on `new_value` can both be replaced with direct `field_path = pc.field_path` equality — the query simplifies significantly.
  - **Phase 10.1 note**: when `change_type` is added to `pending_changes`, filter the second leg with `AND change_type = 'field_edit'` to exclude sentinel rows. Safe to defer — sentinel `new_value`s are `null` and won't match the LIKE pattern.
  - Returns empty list if no rows — never throws.

### `InMemoryRecordRepository`

- [ ] Add stub: `public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => [];`

### Endpoint — `RecordEndpoints.cs`

- [ ] Add `GET /records/{formKey}/references`:
  - URL-decode `formKey` before passing to `_repository.GetReferences()`
  - Returns `IReadOnlyList<ReferenceResult>` — unknown FormKey returns an empty array, not 404
  - Annotations: `.Produces<IReadOnlyList<ReferenceResult>>()` and `.ProducesProblem(500)`
  - Catch/log: `_logger.LogError(ex, "Failed to get references for {FormKey}", formKey)` before `Results.Problem`

### API Client

- [ ] Run `npm run generate-api` (from `medit-vscode/`) after all C# changes are built

## Tests

New file: `MEditService.Tests/Api/ReferenceApiTests.cs` (use the `[Collection("ApiTests")]` pattern with `TestPluginFixture` + `ApiWebAppFixture`)

**Committed references:**
- [ ] Load session; call `GET /records/{weaponFormKey}/references`; assert 200 with at least one `ReferenceResult` whose `FormKey` + `Plugin` match the NPC (or other record) that references the weapon in the test fixture.
- [ ] Unknown FormKey → 200 with `[]`.
- [ ] Malformed FormKey (e.g. `not-a-formkey`) → 200 with `[]` (not 500).

**Pending additions:**
- [ ] Load session; `PATCH` a mutable record to set a FormKey field to `{weaponFormKey}`; call `GET /records/{weaponFormKey}/references`; assert the patched record appears in the result even though it hasn't been saved.

**Pending removals:**
- [ ] Load session; identify a committed reference (NPC → weapon); `PATCH` the NPC to set that FormKey field to `null`; call `GET /records/{weaponFormKey}/references`; assert the NPC is **not** in the result.

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run generate-api` output, and commit hash here.*
