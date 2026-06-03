# Phase 15 — Scripting Engine

**Status: Not Started**

*Prerequisite: Phase B.1 (DuckDB-backed PendingChangeService). Goal: power users write Python scripts against the loaded mod data — the xEdit scripting experience, native to VS Code.*

## Design

Scripts are Python files with a YAML frontmatter block. The frontmatter declares a SQL query that selects the records the script operates on. The script body iterates the query results and calls `edit()` to stage changes. All edits flow through `PendingChangeService` → `PluginWriter` — the same pipeline as manual field edits.

```python
# ---
# name: Scale Nord NPCs
# description: Make all Nord NPCs 10% taller
# context: global
# query: |
#   SELECT form_key, plugin, record_type, height
#   FROM npc WHERE race_editor_id = 'NordRace'
# ---

for row in records:
    edit(row.form_key, row.plugin, row.record_type, "Height", row.height * 1.1)
```

- SQL is the selection layer — leverages DuckDB for filtering, joins across plugins, aggregates
- `edit(form_key, plugin, record_type, field, value)` is the only write API; routes to the `ColumnSpec.Apply` delegate for that `(record_type, field)` pair, same as a UI edit
- Column names in query results are the same names `ColumnSpec` uses (both derived from the same `SchemaReflector` reflection) — no separate stub generation needed
- Scripts run in a Python subprocess; the extension communicates via stdin/stdout JSON-RPC; the user never sees HTTP or transport details
- Scripts are read-only by default (no `edit()` calls); any `edit()` call stages a pending change that the user can review and save or discard

## Backend
- [ ] `POST /query` — execute a SQL SELECT against DuckDB; returns `{ columns: string[], rows: unknown[][] }`; read-only (no DDL/DML); scripts do their own selection here
- [ ] `POST /script/run` — accepts `{ script: string, context: ScriptContext }`; executes the Python subprocess, collects `edit()` calls, stages them as pending changes via `PendingChangeService`; returns `{ editsStaged: number, log: string[] }`
- [ ] `GET /scripts` — list available scripts from user-configurable folder + built-in `extension/scripts/`; returns `{ name, description, context }[]`

## Script format
- [ ] YAML frontmatter: `name`, `description`, `context` (`record | plugin | global`), `query` (SQL string)
- [ ] Token substitution in `query`: `{{formKey}}`, `{{plugin}}`, `{{editorId}}`, `{{type}}` — substituted from context before execution
- [ ] `edit(form_key, plugin, record_type, field, value)` — the only write API available to scripts; raises if `(record_type, field)` has no `ColumnSpec`

## Extension
- [ ] "Run Script…" command on tree context menu + command palette; QuickPick populated from `GET /scripts`
- [ ] Script output panel (append-only log of script stdout + edits staged summary)
- [ ] User setting: `mEdit.scriptsPath` for custom script folder

## Built-in scripts (`extension/scripts/`)
- [ ] `find-references.py` — lists all records referencing current FormKey
- [ ] `list-overrides.py` — lists all FormKeys with >1 override for current plugin
- [ ] `find-itms.py` — finds ITM records in current plugin
- [ ] `conflict-summary.py` — prints conflict counts by record type

## Tests
- [ ] Backend: `POST /query` returns correct columns and rows for a SELECT
- [ ] Backend: `POST /script/run` stages correct pending changes for a script that calls `edit()`
- [ ] Backend: `POST /script/run` rejects a script whose `edit()` references an unknown `(record_type, field)`

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
