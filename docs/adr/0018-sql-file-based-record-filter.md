# Record tree filtering uses raw DuckDB SQL in plain `.sql` files

The record tree filter is a DuckDB SQL SELECT, stored as a plain `.sql` file in `mEdit.scriptsPath`, applied via VS Code Code Lens. The filter must return a `form_key` column; the backend materializes the result into a `_filter` table and joins against it on all subsequent record queries. No structured filter UI controls (toggle buttons, dropdowns) are built.

## Why this is the right choice

A filter is the selection layer of a Phase 15 script — a `query:` with no Python body. Treating them as the same file type means one UX surface instead of two, and a filter naturally upgrades into a full script by adding a Python body.

Keeping filters as plain files gives users and agents identical interfaces: a human writes a `.sql` file and applies it via Code Lens; an agent calls `POST /session/filter` with the same SQL string directly. No separate agent data path.

VS Code provides syntax highlighting, undo history, save, and version control for `.sql` files at zero cost. Building a custom filter webview would be worse UX than the editor the user is already in.

## Considered alternatives

**Structured toggle UI (All / Conflicts / Overrides / Clean)** — simple to use but requires bespoke backend params for each filter dimension, doesn't compose, can't express arbitrary queries, and doesn't serve agents well. Deferred indefinitely: conflict-status filtering is achievable by writing SQL against the per-type tables.

**Modal input box (`showInputBox`)** — fast to build, but no syntax highlighting, no save capability, single-line hostile. Rejected.

**Custom filter webview with Monaco editor** — full SQL editing in a panel, but duplicates VS Code's own editor with worse UX and more maintenance surface. Rejected in favour of opening a real `.sql` file.

**Text substitution macros (`{all-tables}`, `{plugin}`)** — convenience layer over raw SQL for cross-type queries. Deferred: adds a non-trivial substitution layer before we know which macros are actually needed. Users write UNION ALL manually in the meantime.

## Consequences

- `GET /plugins/{plugin}/conflicts` (original Phase 9.6 scope) is deferred — a plugin-scoped conflict filter requires `{plugin}` substitution, which is deferred.
- The "All / Conflicts / Overrides / Clean" toolbar from the mEdit spec (`docs/specs/medit.md`) §2.5 is replaced by the filter QuickPick + Code Lens.
- Phase 15 inherits `mEdit.scriptsPath` and the Code Lens infrastructure rather than building its own.
- Filter SQL runs against real DuckDB table names. Users must know the schema (table names match Mutagen record type names; column names match `ColumnSpec` field names from `SchemaReflector`).
