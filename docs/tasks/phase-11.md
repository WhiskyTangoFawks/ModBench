# Phase 11 — Referenced By / Record Graph

**Status: Not Started**

*Goal: see every record that references a given FormKey — essential for understanding the impact of a change, and a prerequisite for Phase 10 delete and renumber.*

## Backend
- [ ] Add `form_references (source_form_key, source_plugin, target_form_key, field_path, record_type)` table to DuckDB, populated at index time — for every FormLink field encountered during indexing, write one row; this is the indexed read model for reference queries and is required for Phase 10 delete/renumber safety checks
- [ ] `GET /records/{formKey}/references` — queries `form_references` table; returns `{ formKey, editorId, plugin, fieldPath }[]`

## Extension / Webview
- [ ] "Referenced By" tab in the record panel (alongside the compare grid); lazy-loads on tab click
- [ ] Each reference entry: plugin chip + record EditorID + field path; clicking opens that record
- [ ] Empty state: "No references found"

## Tests
- [ ] Backend: `form_references` is populated correctly for a fixture with a known FormLink field
- [ ] Backend: references endpoint returns the referencing NPC when a weapon FormKey is searched
- [ ] Backend: unknown FormKey returns empty array (not 404)

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
