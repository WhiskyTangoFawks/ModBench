---
status: accepted
---

# xEdit unified tree model for the compare grid

## Context

The compare grid shows field values across all loaded plugin overrides for a record. For scalar
fields (string, int, FormKey, enum), each field is one row. For complex fields — arrays and
structs — a design decision is required.

xEdit (the reference tool all mEdit users will be familiar with) uses a single unified tree where
every element — subrecord, struct sub-field, array element — is a node. The tree has one shape;
each node carries one slot per plugin. Plugin columns are aligned at every depth. Sorted arrays
align by sort key across plugins; unsorted arrays align by position.

## Decision

Adopt the xEdit unified tree model. Arrays generate `children` in `FieldDiff` using the same
recursive expansion mechanism used for struct sub-fields:

- **Sorted arrays**: child count = union of sort keys across all plugins. Each child row
  represents one unique element (by FormKey or other sort key). A plugin that lacks that element
  shows an empty cell in its column.
- **Unsorted arrays**: child count = max element count across all plugins. Elements are aligned by
  index.

The parent array row shows the field name and collapses/expands the element sub-rows. Element
sub-rows show each plugin's value for that element. Struct-typed array elements expand further
into their own sub-field rows. Depth is bounded by the data schema, not by a recursion limit.

A complex field is edited as one atomic value: every per-element gesture reconstructs the field's
whole value before writing it to the source document (CONTEXT.md § Complex field).

## Alternatives rejected

- **Per-cell array widget** (the prior implementation, `ArrayRowGroup`): each plugin column
  rendered its own array widget independently. Cross-plugin element comparison was impossible —
  you could not see that plugin A has `KeywordA` while plugin B does not — and reviewing an
  agent's change to an array meant reading a whole JSON blob.
- **Element-level writes** (`field_path = "packages[1]"`): array indices are positional and have
  no stable identity — any insert or delete invalidates every higher index. The atomic
  whole-field model is the correct fit for the data structure.
