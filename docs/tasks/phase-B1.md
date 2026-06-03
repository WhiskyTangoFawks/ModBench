# Phase B.1 — Migrate PendingChangeService to DuckDB

**Status: ✓ Completed**

*Prerequisite for Phase 15 (scripting) and the `hasDelta` filter in Phase 9. Implement before either of those phases.*

## Backend

- [ ] Create `pending_changes` table in DuckDB at session load (in `SessionManager` alongside the existing record tables). Schema from ADR-0017: `id UUID`, `form_key`, `plugin`, `field_path`, `record_type`, `old_value JSON`, `new_value JSON`, `source`, `description`, `changed_at TIMESTAMP`, `group_id UUID NULL`; primary key `(form_key, plugin, field_path)`
- [ ] Rewrite `PendingChangeService` to read/write `pending_changes` via DuckDB instead of `ConcurrentDictionary`. `IPendingChangeService` interface is unchanged — callers see no difference
  - `Upsert`: `INSERT INTO pending_changes ... ON CONFLICT (form_key, plugin, field_path) DO UPDATE SET new_value = excluded.new_value, changed_at = excluded.changed_at` — preserves `old_value` from original insert
  - `GetChanges`: `SELECT * FROM pending_changes` with optional `WHERE plugin=?` / `WHERE form_key=?`
  - `GetPendingFields`: `SELECT field_path, new_value FROM pending_changes WHERE form_key=? AND plugin=?`
  - `Revert(Guid)`: `DELETE FROM pending_changes WHERE id=?`
  - `Revert(plugin, formKey)`: `DELETE FROM pending_changes WHERE plugin=? AND form_key=?`
  - `DrainForPlugin`: `DELETE FROM pending_changes WHERE plugin=? RETURNING *`
- [ ] Drop `pending_changes` table on session end / session reload (same lifecycle as record tables)
- [ ] Inject `IDuckDbConnectionFactory` (or the existing session DuckDB connection) into `PendingChangeService` — remove the `ConcurrentDictionary` field entirely

## Tests

- [ ] All existing `PendingChangeService` unit tests pass against the DuckDB-backed implementation
- [ ] Upsert preserves `OldValue` across multiple edits to the same field
- [ ] `DrainForPlugin` removes rows and returns them atomically
- [ ] Two concurrent upserts to different fields on the same record do not deadlock (DuckDB write serialisation)

## Proof

Completed during the POC stage of the project. No captured test artifacts.
