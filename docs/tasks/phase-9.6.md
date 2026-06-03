# Phase 9.6 — Record Filtering

**Status: Not Started**

*Goal: users can filter the record tree by conflict state, EditorID, and record type without custom precomputed tables.*

Conflict state is derived at query time from the existing DuckDB records table via SQL — no `conflict_state` table to maintain. A form_key has conflicts when any field column has more than one distinct non-null value across its plugin rows (window function / UNPIVOT query).

Filter dimensions compose with AND: `conflictAll`, `hasPendingChanges`, free-text `editorId`. The tree toolbar maps directly to query params on `GET /records`.

## Design notes (to be elaborated before implementation)

- Derive conflict state in SQL: UNPIVOT the records table to (form_key, plugin, field, value) rows, then aggregate — `COUNT(DISTINCT value) > 1` per (form_key, field) identifies conflicting fields; any conflicting field → ConflictAll=Conflict for that form_key.
- ConflictBenign / ConflictCritical filtering requires ConflictPriority metadata (Phase 9.5 prerequisite).
- `hasPendingChanges` filter: join against the pending changes DuckDB table.

## Scope (placeholder — refine before starting)

**Backend**
- [ ] `conflictAll` filter param on `GET /records` — SQL-derived, no precomputed table
- [ ] `hasPendingChanges` filter param on `GET /records`
- [ ] Free-text `editorId` filter (already exists — verify composability)
- [ ] `GET /plugins/{plugin}/conflicts` — records where this plugin ConflictLoses

**Extension**
- [ ] Filter toolbar on plugin tree: All / Conflicts Only / Overrides Only toggle
- [ ] `mEdit.showConflicts` command (palette + tree toolbar button)
- [ ] Top-level Conflicts tree node with count badge
- [ ] Conflict/override badge icons on record tree nodes

## Proof

*To be filled in on completion.*
