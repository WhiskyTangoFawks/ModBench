---
status: accepted
---

# The index is one documents table; reflection over Mutagen's types generates the per-type views and editor metadata

## Decision

**One `records` table holds every record as a document.** Each row is the record's source JSON
(the same bytes as its source file — ADR-0042) beside identity columns: `plugin`, `form_key`,
`record_type`, `editor_id`, `ref`, `content_hash`. The extracted index tables (`form_lookup`,
`form_references`, `placement`, `cell_location`, `plugins`) are populated from the
documents at ingest. The plugin header was the one exception — a per-type wide table of its own
(`author`/`flags`/`masters`), outside the dual-ref model with no `ref`/`body`/`content_hash`.
**Since #631 it is an ordinary `records` row like everything else**, its body the whole-mod
serializer's root `RecordData.json`, at the synthetic FormKey `000000:<plugin>`; the wide table
and its read path are gone. It is not yet a *source unit* (#661), so an external edit to that file
is not detected and `SourceFreshness` skips it deliberately.
`load_order_idx` and `is_winner` read as columns of `records` but are not
stored on it — they are load-order-derived, joined into the registered view from `plugins` and
the `winners` table respectively (ADR-0001). The index is a persistent per-instance cache
(ADR-0001) — deleting it costs one cold index and loses nothing.

**Reflection over Mutagen's record types generates, at startup, three things — never DDL:**

- **One `json_extract` view per record type**, named after the type (`npc`, `weap`, …), carrying
  scalar leaves only. This is what keeps user filter SQL (ADR-0018) working unchanged against the
  documents table. Arrays, structs and other non-scalar fields are not view columns.
- **Editor field metadata** — the `ColumnSpec` tree the record editor renders and edits from.
- **The record codec** (ADR-0032) — the serializer that produces the documents in the first
  place.

**Typed reads reconstitute; they never read the views.** `GetDocument`, `GetOverrideStack` and
every other typed read deserialize the document through the codec and run the same extract
delegates the views are generated from, so values are identical by construction. The published
relational schema is a contract for **the SQL door only**.

When Mutagen adds or changes fields, the views, metadata and codec update on next startup.
Hot fields get promoted to real extracted columns only if measurement demands it — the 2026-08
filter probe over a full FO4 load order found the views fast enough without any.

## Alternatives rejected

- **Reflected per-type wide tables.** Reflect
  `typeof(Npc)` → `CREATE TABLE npc (...)`, scalars as typed columns, arrays and deep structs as
  JSON columns, plus five VMAD/condition side tables. It cost ~130 tables of DDL to maintain, every whole-load-order
  query became a union over all of them, nested lists inside structs silently dropped when the
  reflector had no mapping, and the schema shape was coupled to Mutagen's at DDL time. Once the
  source became the record's text (ADR-0041), the document *was* the natural row, and the 2026-08
  query audit found exactly one field-predicate consumer (user filter SQL) that the generated
  views serve.
- **Hand-written schema** — doubles the maintenance surface; any Mutagen update that adds a field
  requires a migration.
- **Reading the views for typed reads** — a second decode path that could drift from the codec.
