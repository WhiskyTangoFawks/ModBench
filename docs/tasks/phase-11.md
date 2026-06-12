# Phase 11 — Referenced By / Record Graph

**Status: Complete**

*Goal: see every record that references a given FormKey — essential for understanding the impact of a change, and a prerequisite for Phase 10.3 (delete) and Phase 10.4 (renumber).*

---

## Sub-phases

| Phase | Goal | Depends on |
|-------|------|-----------|
| [Phase 11.1](phase-11.1.md) | `form_references` table DDL + populate during `Index()` | — |
| [Phase 11.2](phase-11.2.md) | `GetReferences` repository method, API endpoint, generate API client | 11.1 |
| [Phase 11.3](phase-11.3.md) | "Referenced By" tab in record panel | 11.2 |

**Recommended order:** 11.1 → 11.2 → 11.3

---

## Backend

- [ ] Add `form_references (source_form_key, source_plugin, target_form_key, field_path, record_type)` table to `TableDdlBuilder.CreateTables()` with an index on `target_form_key`
- [ ] At the top of `DuckDbRecordRepository.Index()`, delete existing `form_references` rows for the plugin being indexed (mirrors the per-type record table deletion pattern)
- [ ] Populate `form_references` after indexing each record by iterating `RecordColumns`:
  - `ApiType == "formKey"`: one row; `field_path = col.Name`
  - `ApiType == "array"` + `ElementType.Type == "formKey"`: parse JSON array; one row per non-null element; `field_path = "{col.Name}[{idx}]"`
  - `ApiType == "array"` + `ElementType.Type == "struct"`: parse JSON array; walk `ElementType.Fields` for sub-fields with `Type == "formKey"`; `field_path = "{col.Name}[{idx}].{subFieldName}"`
- [ ] Add `ReferenceResult` DTO to `Queries/Models.cs`: `record ReferenceResult(string FormKey, string Plugin, string FieldPath, string RecordType)`
- [ ] Add `IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey)` to `IRecordReader` and implement in `DuckDbRecordRepository`
- [ ] `GET /records/{formKey}/references` — returns `IReadOnlyList<ReferenceResult>`; unknown FormKey returns empty array (not 404)

## Extension / Webview

- [ ] "Referenced By" tab in the record panel alongside the compare grid; lazy-loads on first tab click
- [ ] Each entry: plugin chip + record EditorID (or FormKey if absent) + field path; clicking opens that record
- [ ] Empty state: "No references found"

## Tests

- [ ] Backend: `form_references` is populated correctly for a fixture with a known FormLink field
- [ ] Backend: references endpoint returns the referencing NPC when a weapon FormKey is searched
- [ ] Backend: unknown FormKey returns empty array (not 404)

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
