# Phase 9 — Conflict Classification & Filtering

**Status: Not Started**

*Goal: users can see the conflict landscape at a glance and drill into only the records that matter.*

Model decided in ADR-0016: two-axis classification (`ConflictAll` per record row + `ConflictThis` per plugin column). See CONTEXT.md for the full enum definitions.

**Tier 1 (this phase):** Two-axis classification using Mutagen typed values. ConflictPriority per field is Tier 2 (later).

**Filter design:** filter dimensions are `conflictAll`, `hasPendingChanges`, and free-text `editorId`. They compose with AND. No separate `GET /conflicts` endpoint — `GET /records?conflictAll=Conflict` is sufficient. The tree toolbar maps directly to query params.

## Backend

**Conflict classifier (`MEditService.Core/Queries/ConflictClassifier.cs`)**
- [ ] Add `ConflictAll` and `ConflictThis` C# enums matching CONTEXT.md definitions
- [ ] `ConflictClassifier.Classify(IReadOnlyList<(string plugin, IRecord record)> overrideStack)` — takes the override stack in load-order position; returns `(ConflictAll, IReadOnlyList<(string plugin, ConflictThis)>)`. Algorithm: compare each plugin's field values against the master (position 0) and against the winning override (last position). Fields absent in a PartialForm record are excluded from comparison.
- [ ] Store `conflict_all` (string enum) in a DuckDB `conflict_state` table keyed on `form_key`, populated/invalidated on every index update — this is the read model for filtering, not for the compare grid. The classifier itself runs in C# over full Mutagen objects.
- [ ] Expose `ConflictAll` and per-plugin `ConflictThis` on the `GET /records/{fk}/compare` response — each plugin column in the compare response gets a `conflictThis` field; the record-level response gets a `conflictAll` field.
- [ ] `GET /records?conflictAll=Conflict|ConflictCritical|Override|ConflictBenign|NoConflict|OnlyOne` — filter parameter maps directly to the `conflict_state` DuckDB table; composable with existing `plugin`, `recordType`, `editorId` filters
- [ ] `GET /plugins/{plugin}/conflicts` — conflict records where this plugin's `ConflictThis` is `ConflictWins` or `ConflictLoses`; sourced from the compare endpoint data

**Display name improvements** (needed for conflict usability)
- [ ] REFR, ACHR, PGRE, PMIS record summaries: resolve the base object FormLink and use its `FULL` name as the display name — bare EditorIDs are nearly always empty on placed objects; xEdit shows the base object's name instead
- [ ] CELL records without EditorID: display as grid coordinates `<X, Y>` from the `XCLC` field

## Extension
- [ ] Top-level "Conflicts" tree node showing total conflict count badge; lazy-loads `GET /records?conflictAll=Conflict,ConflictCritical`
- [ ] Conflict and override badge icons on record nodes in the tree (drives `contextValue` on tree nodes)
- [ ] Filter toolbar on plugin tree: "All" / "Conflicts Only" / "Overrides Only" toggle — maps to `conflictAll` query param
- [ ] `mEdit.showConflicts` command (palette + tree toolbar button)
- [ ] General record tree filter: free-text search by EditorID or FormKey, record type dropdown; composable with conflict-state toggle via AND

## Webview
- [ ] Record row background color driven by `ConflictAll`: no color (OnlyOne/NoConflict), green (Override), yellow (ConflictBenign), orange (Conflict), red (ConflictCritical) — same palette xEdit uses
- [ ] Per-plugin column cell color driven by `ConflictThis`: grey (IdenticalToMaster), green (Override), yellow (ConflictBenign), orange (ConflictWins), red (ConflictLoses), no color (Master/OnlyOne)
- [ ] PartialForm columns: absent fields are omitted from the column (empty cell, no color), not shown as blank — add a tooltip or italicised "partial" badge on the column header

## Tests
- [ ] Backend: `ConflictClassifier` returns `ConflictAll=Conflict`, winning plugin `ConflictThis=ConflictWins`, losing plugin `ConflictThis=ConflictLoses` for a two-plugin fixture where both override the same field with different values
- [ ] Backend: `ConflictClassifier` returns `ConflictAll=Override`, both plugins `ConflictThis=IdenticalToMaster` when the override copies values identically
- [ ] Backend: `ConflictClassifier` correctly handles a PartialForm record in the stack (absent fields do not generate ConflictLoses)
- [ ] Backend: `GET /records?conflictAll=Conflict` returns only conflicting records from the index
- [ ] Backend: free-text `editorId` filter on `GET /records` returns matching records across all loaded plugins
- [ ] Backend: REFR compare response uses base object FULL name as display name when EditorID is absent

## Proof

*To be filled in on completion. Paste `dotnet test` output, `npm run test:unit` output, and commit hash here.*
