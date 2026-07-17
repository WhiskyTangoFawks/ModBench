# ADR-0017: Pending change model design

**Status:** Accepted  
**Date:** 2026-06-02

## Context

Phase 4 shipped a working pending-change model: a `ConcurrentDictionary` keyed on `(FormKey, Plugin, FieldPath)` holding one `PendingChange` per field edit. Phase 10 extends this model with multi-record lifecycle operations (Create, Delete, Renumber), which introduce the concept of grouped changes that must be applied and reverted atomically. Before implementing Phase 10 the model needs five design questions answered.

## Decisions

### 1. Storage — DuckDB session table

Pending changes are stored in a `pending_changes` table in the existing in-session DuckDB instance. The table is created at session load and dropped at session end — it is in-memory for the lifetime of the session and is lost if the backend restarts.

**Schema:**

```sql
CREATE TABLE pending_changes (
    id          UUID        NOT NULL,
    form_key    VARCHAR     NOT NULL,
    plugin      VARCHAR     NOT NULL,
    field_path  VARCHAR     NOT NULL,
    record_type VARCHAR     NOT NULL,
    old_value   JSON,
    new_value   JSON        NOT NULL,
    source      VARCHAR     NOT NULL,   -- 'user' | 'agent'
    description VARCHAR,
    changed_at  TIMESTAMP   NOT NULL,
    group_id    UUID,                   -- NULL for standalone edits
    PRIMARY KEY (form_key, plugin, field_path)
);
```

**Rationale:** DuckDB is already the session query engine and is in-process. Storing pending changes there rather than in a `ConcurrentDictionary` eliminates a second in-memory store and makes the full change set composable with record data via SQL. Scripts (Phase 15) can join `pending_changes` with record tables naturally — `WHERE (form_key, plugin) IN (SELECT form_key, plugin FROM pending_changes)` — without any pre-processing in C#. The `conflict_state` table (Phase 9) is the precedent: DuckDB holds both committed record data and session-scoped metadata.

Loss-on-restart remains the intended behaviour. Persistence across restarts is not a requirement; the user must commit changes to disk before cycling the backend. A SQLite sidecar is still rejected — the goal is not durability, it is SQL composability within a session.

**What this means for implementation:** `PendingChangeService` becomes a thin wrapper around DuckDB reads and writes instead of a `ConcurrentDictionary`. `IPendingChangeService` is unchanged — callers do not see the difference.

### 2. Granularity — field-level deltas

Each row in `pending_changes` represents one field on one record in one plugin: `(form_key, plugin, field_path)` is the primary key. This is the existing model; it stays.

The field-delta model directly supports every target UX operation:

| UX action | Implementation |
|---|---|
| Right-click field → revert this field | `DELETE /changes/{id}` — deletes exactly that one row |
| Field delta indicator in compare grid | `SELECT field_path FROM pending_changes WHERE form_key=? AND plugin=?` |
| Right-click record → revert all fields | `DELETE /changes?formKey=X&plugin=Y` — deletes all rows for the pair |
| Filter records by has pending changes | `WHERE (form_key, plugin) IN (SELECT form_key, plugin FROM pending_changes)` |
| Nuclear revert all | `DELETE FROM pending_changes` |

A full-record snapshot alternative (one entry per `(FormKey, Plugin)` storing the whole new record) would make per-field revert require reconstructing the record state minus the reverted field — substantially more complex with no offsetting gain. `PluginWriter` already applies fields one by one correctly.

**Extension for Phase 10:** `pending_changes` gains a `change_type` column (`field_edit | create | delete`). `create` and `delete` rows have no meaningful `field_path`/`old_value`/`new_value`; `PluginWriter` dispatches on `change_type` rather than trying to apply a field delta for those entries.

### 3. Merge semantics — upsert-in-place preserving OldValue

Re-editing the same `(form_key, plugin, field_path)` triple updates `new_value` in the existing row, leaving `old_value` unchanged (the original on-disk value). There is always at most one pending change per field.

This is the correct behaviour. The user can always see the delta against disk regardless of how many times they changed the field in the UI. The upsert is expressed as a DuckDB `INSERT OR REPLACE` (or `ON CONFLICT (form_key, plugin, field_path) DO UPDATE SET new_value = excluded.new_value, changed_at = excluded.changed_at`), preserving `old_value` from the original insert.

### 4. ChangeGroup revert — atomic only

A `ChangeGroup` is a named set of `pending_changes` rows that form a logically indivisible operation (e.g. delete a record + nullify all FormLink references pointing to it across editable plugins; renumber a FormKey + update all referencing fields). The `group_id` column links member rows to their group.

**Revert semantics:**

- You cannot revert an individual change that belongs to a group. `DELETE /changes/{id}` returns 409 if the row has a non-null `group_id`, with the group ID in the error body.
- You revert the entire group via `DELETE /changes/group/{groupId}` — all rows with that `group_id` are deleted in one transaction.
- Standalone field edits (`group_id IS NULL`) remain freely per-field revertable.

**Rationale:** allowing partial revert of a group produces incoherent intermediate states. If a delete group is half-reverted (the deletion reverted but the nullifications left in place), the record is back but fields that referenced it are still nulled — a silent data error. Atomic group revert eliminates this class of problem entirely.

### 5. Pending changes panel — design

> **Superseded in full by [ADR-0029](0029-pending-changes-tree-is-a-grouping-view.md).** Its
> location (bottom panel), its structure (plugin → record → field plus a `ChangeGroups`
> section), and its action table (per-field/record/plugin/group/global scopes) are all
> replaced. ADR-0028's grouping model is what makes them unworkable: a derived group has no
> identity to list, and may span plugins, so the per-plugin and per-record scopes below could
> only be honoured by splitting a group. §§1–3 of this ADR are unaffected and remain the
> storage model; §4 remains superseded in part by ADR-0028. The rest of this section is kept
> as a record of the original decision — do not build from it.

**Location:** bottom panel tab (alongside the integrated terminal area), not a sidebar tree. The sidebar is already used for the plugin/record tree; a bottom panel keeps the record editor and pending-changes summary simultaneously visible.

**Content and grouping:**

```
Pending Changes (12)
├── MyPatch.esp (8 changes)
│   ├── NPC_ [NPC0:001234:Skyrim.esm]  "Ulfric Stormcloak"   3 fields  [Revert record] [Save]
│   │   ├── Height        0.97 → 1.05                                   [Revert]
│   │   ├── Weight        50.0 → 55.0                                   [Revert]
│   │   └── HairColor     [Hair01:...] → [Hair02:...]                   [Revert]
│   └── WEAP [WEAP:002345:Skyrim.esm]  "Iron Sword"          1 field   [Revert record] [Save]
│       └── Damage        8 → 10                                        [Revert]
└── ChangeGroups (1 group)
    └── Delete NPC0:001234:MyPatch.esp  (5 changes)                     [Revert group] [Save group]
        ├── Delete NPC0:001234:MyPatch.esp
        ├── Nullify WEAP:002345:... → NPC.BoundWeapon
        └── …
```

**Actions available:**

| Scope | Action |
|---|---|
| Per-field | Revert |
| Per-record | Revert all fields for `(FormKey, Plugin)` |
| Per-plugin | Save (writes all pending changes for that plugin to disk) |
| Per-group | Revert group (atomic); Save group (atomic) |
| Global | Revert all; Save all |

**Tree node context values** for the extension tree provider: `"pendingPlugin"`, `"pendingRecord"`, `"pendingField"`, `"pendingGroup"`. These drive the context menu `when` clauses in `package.json`.

**Update cadence:** the panel subscribes to a `ChangesUpdated` event emitted by `PendingChangeService` after any `Upsert`, `Revert`, or `Drain` call. The extension polls `GET /changes` on the event and refreshes the tree.

## What Phase 10 adds to this model

Phase 10 does not redesign the model — it extends it:

- `change_type` column on `pending_changes`
- `group_id` column on `pending_changes` (already in the schema above)
- `change_groups` table tracked alongside `pending_changes`
- New endpoints: `GET /change-groups`, `DELETE /changes/group/{id}`, `POST /change-groups/{id}/save`
- 409 guards on `PATCH /records/{fk}` and `DELETE /changes/{id}` for group-owned changes

All of these are additive. The existing field-edit path is unchanged.

## Alternatives rejected

**ConcurrentDictionary (original implementation)** — fast in-process lookups, but a second in-memory store that scripts cannot query with SQL. `hasDelta` filtering in Phase 15 scripts would require C# pre-processing to inject an IN-list into arbitrary user SQL, which is fragile. DuckDB is already in-process and provides the same performance characteristics with full SQL composability.

**SQLite sidecar for persistence** — adds a new storage dependency and schema migration complexity. The goal is SQL composability within a session, not durability across restarts. Loss-on-restart is acceptable and desirable.

**Full-record snapshot** — makes per-field revert complex (must reconstruct record state minus the reverted field). No benefit over field deltas for the target UX. The apply path in `PluginWriter` is not meaningfully simpler.

**Per-change revert within a group** — permits incoherent intermediate states (e.g. delete reverted but reference nullifications still pending). Atomic group revert eliminates this class of data error.

**Sidebar panel for pending changes** — would require a dedicated sidebar view container. The sidebar is already occupied by the plugin/record tree. A bottom panel keeps both visible simultaneously and matches the established IDE pattern for staged-change summaries.
