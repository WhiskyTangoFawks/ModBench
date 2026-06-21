# Phase 12 — Complex Field Display & Editing

**Status: Not Started**

*Goal: array and struct fields are fully editable with correct round-trip behavior. Flag enum fields render as multi-select checkboxes. Arrays appear in the compare grid as element sub-rows aligned across plugin columns (xEdit unified tree model, ADR-0019) rather than per-cell widgets.*

---

## Sub-phases

| Phase | Goal | Depends on |
|-------|------|-----------|
| [Phase 12.1](phase-12.1.md) | Flag enum / bitmask support — `isBitmask` on `FieldMetadata`, `FlagCell` component | — |
| [Phase 12.2](phase-12.2.md) | Array child rows (backend) — `BuildArrayChildren()` in `ConflictClassifier`, sorted/unsorted alignment, recursive depth | — |
| [Phase 12.3](phase-12.3.md) | Array child rows (frontend) — retire `ArrayRowGroup` from compare grid, pending display per element row, revert on parent | 12.2 |
| [Phase 12.4](phase-12.4.md) | Struct edit verification & fixes — audit and harden existing struct sub-row edit path | — |

**Recommended order:** 12.1 and 12.4 can run in parallel (no shared dependencies). 12.2 before 12.3.

---

## What was already implemented before this phase

The following were built in earlier phases and are **not** being re-implemented here:

- `SchemaReflector`: already reflects `array`, `struct`, `enum`, `formKey` types with full recursive metadata (`ElementType`, `Fields`, `EnumValues`, `ValidFormKeyTypes`, `IsSortable`)
- `FieldMetadata` DTO: already has `elementType`, `fields`, `enumValues`, `validFormKeyTypes`, `isSortable`
- `DuckDbRecordRepository.Index()`: already collects `form_references` from array-of-FormKey and array-of-struct fields
- `PluginWriter`: already has Apply delegates for array and struct fields
- `BuildStructChildren()` in `ConflictClassifier`: already generates struct sub-field child diffs
- `StructRowGroup` component: exists, used inside `ArrayRowGroup`

---

## Key Decisions (from design session)

- **Array pending changes are atomic at column level** — one pending change per column, storing the full new array as JSON. There is no per-element pending change. Rationale: array indices are positional with no stable identity; any insert or delete invalidates index-based pending changes. See ADR-0019.
- **xEdit unified tree model for arrays** — arrays produce `diff.children` aligned by sort key (sorted) or index (unsorted), matching the struct expansion pattern. `ArrayRowGroup` is retired from the compare grid. See ADR-0019.
- **VMAD is out of scope** — Papyrus script data requires dedicated DuckDB tables and a separate import/hydration path outside the generic reflection pipeline. See Phase 13.

---

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
