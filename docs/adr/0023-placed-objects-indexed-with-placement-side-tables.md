# Placed objects are indexed records; GRUP parentage lives in side tables

Phase 16 renders the xEdit-style worldspace tree (`Worldspace → Block → Sub-block → Cell
→ Persistent/Temporary → placed refs`) per plugin, and supports the standard record
operations on placed objects (REFR/ACHR).

## Decision

**Placed references are normal indexed records.** `refr` and `achr` are removed from
`SchemaReflector._excludedTables`, so they get reflection-generated DuckDB tables exactly
like `weap`/`npc_`. Reads, record detail (`GET /records/{fk}`), copy/delete, and agent SQL
are therefore uniform DuckDB queries — no live-mod walks, no fallback code paths, no
reverse scans.

**Structural parentage lives in side tables, not on the record.** A placed ref carries no
containing-cell field (verified in `PlacedObject_Generated.cs`); parentage is GRUP nesting
that `EnumerateMajorRecords` flattens away. Two side tables (mirroring `form_references` /
`vmad_*`) hold it, populated by a structural pass during `Index`:

- `placement(form_key, plugin, parent_cell, placement_group, pos_x, pos_y, pos_z)`
- `cell_location(cell_form_key, plugin, parent_worldspace, block_x, block_y, sub_x, sub_y, grid_x, grid_y, is_interior)`

Keeping parentage off the reflected record table means placement is **read-only by
construction** (it never appears as an editable field) and isolates "move a ref between
cells" as a structural op rather than a field edit.

**The structural walk is game-agnostic via reflection** (`PlacementWalker`). Mutagen
generates uniform property names across games (`Worldspaces`, `SubCells`, `Persistent`,
`Grid`, ...), so the walker reflects on those names rather than a game-specific interface —
consistent with the reflection-driven `SchemaReflector` and the "support all games without
code changes" invariant. (The Mutagen `ModContext` parent chain was considered but it
exposes the parent cell, not the persistent-vs-temporary sub-group the tree needs.)

**Reads are per-plugin** (`GET /plugins/{plugin}/...`): the tree shows exactly what a
plugin declares — its records and overrides — never a cross-plugin winner/merge, matching
xEdit's per-plugin view.

## Consequences

- One-time cost: the indexing walk + storage for placed refs on each session load (the
  DuckDB index is `:memory:`, rebuilt per session). Accepted as consistent with how every
  other record type is already indexed each load.
- `pos_x/y/z` is captured during the same walk so spatial search (point/radius/bbox) is not
  foreclosed; region/grid queries are already served by `cell_location` grid columns. A
  DuckDB `spatial` extension (R-tree/`GEOMETRY`) can layer on additively later.

## Rejected alternative — on-demand traversal

Walk the live Mutagen overlay per lazy expand, indexing nothing for placed refs. Lighter on
session load, but forced four special-case mechanisms: a live-mod read path for the tree, a
fallback detail path for the editor, a reverse cell scan for copy/delete, and a
"copy/delete only from the tree" constraint (no agent/flat-search entry point). Indexing
collapses all four into uniform DuckDB queries, so it was chosen despite the index cost.
