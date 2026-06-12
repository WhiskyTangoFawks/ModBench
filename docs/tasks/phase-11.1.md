# Phase 11.1 — `form_references` Table & Indexing

**Status: Complete**

*Goal: add the `form_references` DuckDB table and populate it during `Index()` by walking `RecordColumns` for FormKey fields. No API surface yet — pure data infrastructure that Phase 11.2 builds on.*

---

## Backend

### DDL — `TableDdlBuilder`

- [ ] Add a `CreateFormReferencesTable(DuckDBConnection connection)` static method to `MEditService.Core/Records/TableDdlBuilder.cs`:
  ```sql
  CREATE TABLE IF NOT EXISTS form_references (
      source_form_key VARCHAR NOT NULL,
      source_plugin   VARCHAR NOT NULL,
      target_form_key VARCHAR NOT NULL,
      field_path      VARCHAR NOT NULL,
      record_type     VARCHAR NOT NULL
  )
  ```
  Then in the same method call:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_form_references_target
      ON form_references(target_form_key)
  ```
- [ ] Call `CreateFormReferencesTable(connection)` from `CreateTables()` alongside the existing `CreatePluginsTable` / `CreateIndexStateTable` calls

### Indexing — `DuckDbRecordRepository`

- [ ] At the top of `Index()`, before the per-type `foreach` loop, delete all existing `form_references` rows for the plugin being indexed:
  ```csharp
  DeleteFormReferencesForPlugin(plugin);
  ```
  Implement as a private helper using `DELETE FROM form_references WHERE source_plugin = $1`.

- [ ] Accumulate form references during the per-record loop. Introduce a `record struct FormRef(string SourceFormKey, string TargetFormKey, string FieldPath, string RecordType)` as a file-scoped private type in the same file. Declare `var refs = new List<FormRef>()` before the outer `foreach`.

- [ ] After `row.EndRow()` for each record, call `CollectFormRefs(refs, record, tableName, schema)`. Implement as a private static method:
  - For each `col` in `schema.RecordColumns`:
    - **`col.ApiType == "formKey"`**: call `col.Extract(record)` → if non-null, add `new FormRef(record.FormKey.ToString(), (string)value, col.Name, tableName)`.
    - **`col.ApiType == "array"` AND `col.ElementType?.Type == "formKey"`**: call `col.Extract(record)` → if non-null, `JsonSerializer.Deserialize<JsonElement?>((string)value)`; iterate the array; for each non-null element string at index `idx`, add `new FormRef(record.FormKey.ToString(), element.GetString()!, $"{col.Name}[{idx}]", tableName)`.
    - **`col.ApiType == "array"` AND `col.ElementType?.Type == "struct"`**: call `col.Extract(record)` → if non-null, parse as `JsonElement`; iterate the array; for each object element at index `idx`, walk `col.ElementType.Fields` for sub-fields with `Type == "formKey"`; for each such sub-field with a non-null JSON value, add `new FormRef(record.FormKey.ToString(), subFieldValue, $"{col.Name}[{idx}].{subField.Name}", tableName)`.

- [ ] After the outer `foreach` loop (all record types indexed), flush `refs` using a DuckDB appender:
  ```csharp
  if (refs.Count > 0)
  {
      using var refAppender = _connection.CreateAppender("form_references");
      foreach (var r in refs)
      {
          var row = refAppender.CreateRow();
          row.AppendValue(r.SourceFormKey);
          row.AppendValue(plugin);
          row.AppendValue(r.TargetFormKey);
          row.AppendValue(r.FieldPath);
          row.AppendValue(r.RecordType);
          row.EndRow();
      }
  }
  ```

## Tests

**Shared fixture** — define a `PluginFixtureBuilder` setup at the top of `FormReferencesTests.cs` (or in a shared `ReferenceFixture` helper reused by 11.2 and 10.3/10.4): an `NPC_` record (`Npc1`) with `Race` (RNAM) set to a `RACE` record's FormKey. `Race` is a scalar `wbFormIDCk(RNAM, 'Race', [RACE])` field confirmed in `wbDefinitionsFO4.pas:10701` — a clean single-FormLink case with no array complexity.

New file: `MEditService.Tests/Indexing/FormReferencesTests.cs`

- [ ] Index the shared NPC_/Race fixture. After `Index()` + `UpdateWinners()`, query `form_references` directly:
  ```sql
  SELECT * FROM form_references WHERE source_form_key = $1
  ```
  Assert one row exists with `target_form_key = raceFormKey`, `field_path = "Race"`, `record_type = "NPC_"`.

- [ ] Index a plugin with no FormLink fields → `form_references` remains empty for that plugin (count = 0).

- [ ] Re-index the same plugin → old `form_references` rows for that plugin are replaced, not duplicated (count remains the same after re-indexing).

## Proof

*To be filled in on completion. Paste `dotnet test` output and commit hash here.*
