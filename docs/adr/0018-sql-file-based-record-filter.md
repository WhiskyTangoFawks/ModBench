---
status: accepted
---

# Record tree filtering uses raw DuckDB SQL in plain `.sql` files

The record tree filter is a DuckDB SQL SELECT, stored as a plain `.sql` file in
`modbench.scriptsPath`, applied via VS Code Code Lens. The filter must return a `form_key` column;
the backend materializes the result into a `_filter` table and joins against it on all subsequent
record queries. No structured filter UI controls (toggle buttons, dropdowns) are built.

**A filter acts only on the level it names.** The plugin-name filter hides plugin rows. The record
filter prunes records and record types; the backend still returns every plugin with
`HasMatchingRecords` as an additive fact, and the Plugins tree hides a plugin the active record
filter matches nothing of ([ADR-0035](0035-one-plugins-tree-editing-is-a-capability.md)).

## Why this is the right choice

A filter is the selection layer of a script — a query with no Python body. Treating them as the
same file type means one UX surface instead of two, and a filter naturally upgrades into a full
script by adding a Python body.

Keeping filters as plain files gives users and agents identical interfaces: a human writes a
`.sql` file and applies it via Code Lens; an agent calls `POST /load-order/filter` with the same
SQL string directly. No separate agent data path.

VS Code provides syntax highlighting, undo history, save, and version control for `.sql` files at
zero cost. Building a custom filter webview would be worse UX than the editor the user is already
in.

## Consequences

- Filter SQL runs against the generated per-type `json_extract` views (ADR-0005): view names
  match Mutagen record type names, column names match `ColumnSpec` field names from
  `SchemaReflector`, and only scalar leaves are columns. Users must know that schema.
- Scripts inherit `modbench.scriptsPath` and the Code Lens infrastructure rather than building
  their own.
- A plugin-scoped conflict endpoint is still not built. The reason originally given here — plugin
  scoping via `Apply Filter to Selected` — no longer holds: that gesture (#574) and the Plugins
  tree's own conflict surface it would have scoped (the Conflicts node, #624) have both been
  removed. `GET /records/conflicts` itself has since been deleted as dead code (#558).

## Alternatives rejected

- **Structured toggle UI (All / Conflicts / Overrides / Clean)** — simple to use but requires
  bespoke backend params for each filter dimension, doesn't compose, can't express arbitrary
  queries, and doesn't serve agents well. Conflict-status filtering is SQL against the views.
- **Modal input box (`showInputBox`)** — fast to build, but no syntax highlighting, no save,
  single-line hostile.
- **Custom filter webview with Monaco editor** — duplicates VS Code's own editor with worse UX
  and more maintenance surface.
- **Text substitution macros (`{all-tables}`, `{plugin}`)** — deferred: a non-trivial
  substitution layer before we know which macros are needed. Users write `UNION ALL` manually.
