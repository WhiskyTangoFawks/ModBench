---
status: accepted
---

# Placed objects are indexed records; GRUP parentage lives in side tables

The Plugins tree renders the xEdit-style worldspace tree (`Worldspace → Block → Sub-block → Cell
→ Persistent/Temporary → placed refs`) per plugin, and supports the standard record operations on
placed objects (REFR/ACHR).

## Decision

**Placed references are normal indexed records.** REFR and ACHR are indexed as documents exactly
like WEAP or NPC_ (ADR-0005). Reads, record detail (`GET /records/{fk}`), copy/delete, and agent
SQL are therefore uniform DuckDB queries — no live-mod walks, no fallback code paths, no reverse
scans.

**Structural parentage lives in side tables, not on the record.** A placed ref carries no
containing-cell field (verified in `PlacedObject_Generated.cs`); parentage is GRUP nesting that
`EnumerateMajorRecords` flattens away. Two index tables hold it, populated by a structural pass at
ingest and re-derived on structural writes:

- `placement(form_key, plugin, parent_cell, placement_group, pos_x, pos_y, pos_z)`
- `cell_location(cell_form_key, plugin, parent_worldspace, block_x, block_y, sub_x, sub_y, grid_x, grid_y, is_interior)`

Keeping parentage off the record means placement is **read-only by construction** (it never
appears as an editable field) and isolates "move a ref between cells" as a structural op rather
than a field edit. In a tracked mod's source, the same containment is the directory path
(ADR-0041).

**The structural walk is game-agnostic via reflection** (`PlacementWalker`). Mutagen generates
uniform property names across games (`Worldspaces`, `SubCells`, `Persistent`, `Grid`, …), so the
walker reflects on those names rather than a game-specific interface — consistent with the
reflection-driven schema and the "support all games without code changes" invariant. (The Mutagen
`ModContext` parent chain was considered but exposes the parent cell, not the
persistent-vs-temporary sub-group the tree needs.)

**Reads are per-plugin** (`GET /plugins/{plugin}/...`): the tree shows exactly what a plugin
declares — its records and overrides — never a cross-plugin winner/merge, matching xEdit's
per-plugin view.

## Consequences

- One-time cost: the indexing walk + storage for placed refs on each session load (the index is
  `:memory:`, rebuilt per session). Consistent with how every other record type is indexed.
- `pos_x/y/z` is captured during the same walk so spatial search (point/radius/bbox) is not
  foreclosed; region/grid queries are already served by `cell_location` grid columns. A DuckDB
  `spatial` extension can layer on additively later.

## Alternatives rejected

- **On-demand traversal** — walk the live Mutagen overlay per lazy expand, indexing nothing for
  placed refs. Lighter on session load, but forced four special-case mechanisms: a live-mod read
  path for the tree, a fallback detail path for the editor, a reverse cell scan for copy/delete,
  and a "copy/delete only from the tree" constraint (no agent/flat-search entry point). Indexing
  collapses all four into uniform DuckDB queries.
