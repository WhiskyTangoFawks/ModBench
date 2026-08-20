---
status: superseded by ADR-0041
---

# Reads overlay pending changes via generated logical views

> **Superseded by [ADR-0041](0041-manual-git-tracking-compile-from-text.md)
> (2026-08-19):** the `pending_changes` table and the overlay views built on it are
> gone — a session's DuckDB index has no pending-change concept at all
> (`SessionDatabaseTablesTests.ALoadedSession_HasNoPendingChangeTables`). Filter SQL
> now runs against generated `json_extract` views over the one `records` documents
> table, materialised once per apply — see `docs/specs/plugins.md` § Record filter
> (SQL) and ADR-0041's filter-probe verdict (#366, #411). Kept for history below.

SQL reads — the ADR-0018 record filter, Phase 15 scripts, and internal read paths — query **current state** (committed + staged), not just committed on-disk data. This is provided by generated per-record-type DuckDB **logical views** that overlay `pending_changes` onto the committed base tables. (Phase B.2.)

## Decision

For each record type, the committed base table (one row per `(form_key, plugin)`, ADR-0006) is renamed `<type>_committed`, and a logical view `<type>` exposes current state by overlaying `pending_changes`:

- **Field edits** — `COALESCE` the staged value over the committed column, cast to the column type.
- **Creates / deletes** — `UNION` pending-created rows, anti-join pending-deleted rows (lands with Phase 10).

The view name is the record-type name (`npc`, `weap`, …), so users, scripts, and agents keep writing SQL against `<type>` (ADR-0018) and now see current state by default. Read paths that genuinely need committed-only data (the conflict classifier compares committed per-plugin override values) point at `<type>_committed`.

View DDL is generated from `RecordTableSchema` in `TableDdlBuilder` alongside the base-table DDL (ADR-0005) — not hand-maintained per type.

## Why a logical view, not a materialized one

DuckDB (engine behind DuckDB.NET 1.5.2) has no materialized views — only logical `CREATE VIEW` (re-evaluated at query time) or `CREATE TABLE AS` snapshots. A logical view is the right tool *because* `pending_changes` mutates on every `edit()`: a materialized snapshot would need a refresh after every stage/discard, plus invalidation logic and a staleness window. A logical view is always live against current `pending_changes` with zero refresh.

It also centralizes overlay logic. Today it is hand-written into each query that cares (e.g. `GetReferences` merges `pending_changes` by hand) and the filter ignores staged state entirely (`CREATE TABLE _filter AS ({sql})` runs against committed tables). The view subsumes both, so raw SQL gets *simpler* in the presence of staged edits, not harder.

## Consequences

- `_filter` materialization and record read queries repoint at the views; hand-written overlay logic the view subsumes is removed.
- The overlay must cast staged values (stored as JSON in `pending_changes`) back to each committed column's type.
- Per-column correlated `COALESCE` vs pivoting a record's `pending_changes` rows into columns then `LEFT JOIN` is a perf choice to measure (Phase B.2), not an architectural one.
- A script's `SELECT` no longer matches the on-disk plugin until save — a conscious accepted trade-off so multi-pass scripts and "stage manually, then run a cleanup script" workflows operate on the state the user sees.
