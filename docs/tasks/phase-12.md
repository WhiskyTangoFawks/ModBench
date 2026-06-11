# Phase 12 — Struct/Array Field Types

**Status: Not Started**

*Goal: complex fields (keyword lists, NPC traits, weapon damage entries) render instead of being silently omitted, with full type safety derived from Mutagen's reflection model.*

WE ALSO NEED TO FIGURE OUT VMAD

## Backend

### Pending changes — element-level granularity

Currently `pending_changes` stores one row per column (`field_path = "Packages"`), with the entire serialized column as `new_value`. This makes individual element revert impossible and creates a granularity mismatch with `form_references` (which tracks element paths like `"Packages[1].Reference"`). Array editing requires element-level storage.

- [ ] Change `pending_changes` primary key and storage so that array element edits are stored at element granularity: `field_path = "Packages[1]"`, `new_value = '{"Reference":"..."}'` — one row per touched element, not one row per column
- [ ] Define and implement array operations as first-class change types: element insert, element delete, element field edit — each stored as a separate row
- [ ] Update `DuckDbPendingChangeService.Upsert()` to accept element-path keys (e.g. `"Packages[1].Reference"`) in addition to column-level keys; deprecate column-level array writes
- [ ] Update `PluginWriter` apply logic to merge element-level changes back into the full array on save
- [ ] Update `GetReferences` SQL in `DuckDbRecordRepository` — with element-level pending changes the granularity mismatch disappears; the `LIKE field_path || '[%'` workaround can be replaced with direct `field_path = pc.field_path` matching

### Schema & serialization
- [ ] `SchemaGenerator`: serialize `IReadOnlyList<T>` / `ExtendedList<T>` as JSON `VARCHAR`; emit `type: 'array'` in field metadata; element type recursively reflected
- [ ] `SchemaGenerator`: for nested struct properties (getter interfaces, C# value types), walk the type's own properties recursively via reflection to produce a `fields: FieldMetadata[]` sub-schema — same shape as top-level field metadata, so the frontend gets `name`, `type`, `enumValues`, `validFormKeyTypes` at every nesting level
- [ ] Sub-schema generation is recursive (structs can contain FormLinks, enums, further structs); stop at primitives and known leaf types
- [ ] `PluginWriter`: handle JSON round-trip for array and struct fields on write; use sub-schema to apply individual sub-field writes with correct types (no raw string coercion)

## Extension / Webview
- [ ] `<ArrayRowGroup>`: collapsible row-group; each element a child row; add/remove in edit mode
- [ ] `<StructRowGroup>`: collapsible row-group; each property a child row with type-correct cell (uses sub-schema `FieldMetadata` to drive `ScalarCell` / `FormKeyCell` / nested group)
- [ ] Edit inputs for struct sub-fields and array elements are driven by the sub-schema type — no free-text JSON entry; the type hierarchy from Mutagen reflection is the source of truth
- [ ] Collapsed by default; expand state persisted per session
- [ ] Enum scalar fields render as `<select>` dropdown in edit mode; option list sourced from schema `enumValues`; displayed as enum name in read mode (never raw integer)
- [ ] Flag fields (bit-flag enums, e.g. NPC flags) render as a multi-select dropdown with per-flag checkboxes in edit mode; displayed as comma-separated active flag names in read mode

## Tests
- [ ] Backend: `SchemaGenerator` emits `type: 'array'` for a known list property (e.g. `IKeywordGetter` list)
- [ ] Backend: struct sub-schema contains correct `FieldMetadata` entries (names + types) for a known Mutagen getter interface
- [ ] Backend: array field survives round-trip through write → re-index → read
- [ ] Webview: enum field renders a `<select>` with the correct options in edit mode
- [ ] Webview: flag field renders checkboxes; toggling one flag updates only that bit in the pending value

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
