# Phase B — Pending Change Model Redesign

**Status: ✓ Completed**

*Design complete. See [ADR-0017](../adr/0017-pending-change-model.md) for the full rationale.*

**Decisions:**
- **Storage:** DuckDB session table (`pending_changes`) — same in-process store as the record index, lost on restart, fully SQL-composable for scripts
- **Granularity:** field-level deltas — one row per `(form_key, plugin, field_path)`; supports per-field revert, per-record revert, and `hasDelta` filtering via plain SQL joins
- **Merge semantics:** upsert-in-place preserving `old_value` — `ON CONFLICT DO UPDATE SET new_value` leaves `old_value` from the original insert
- **ChangeGroup revert:** atomic only; `DELETE /changes/{id}` returns 409 for group-owned rows; use `DELETE /changes/group/{id}` instead
- **UI:** bottom panel tab (not sidebar); tree grouped by plugin then record, with ChangeGroups as a separate section; per-field / per-record / per-group / global revert and save actions

Phase 10 is now unblocked.

## Proof

Completed during the POC stage of the project. No captured test artifacts.
