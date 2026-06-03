# Phase 9.7 — Per-Cell ConflictThis + Single-Plugin Field Display

**Status: Not Started**

*Goal: fix two regressions introduced in phase 9.*

1. **Single-plugin records show no fields.** `ConflictClassifier.Classify` returns `diffs = []` when `overrides.Count <= 1`. The webview renders nothing.
2. **ConflictThis is per-plugin (column-level), not per-cell.** The ADR requires ConflictThis to be computed per-field per-plugin and drive each cell's background and text color individually. The current implementation applies one ConflictThis value uniformly across an entire plugin column.

See ADR-0016 and UI_SPEC.md §3.2 for the authoritative design.

## Backend

**`ConflictClassifier` — single-plugin diffs (Bug 1)**
- [ ] When `overrides.Count == 1`, compute field diffs from that plugin's fields (same filtering as the multi-plugin path: exclude rows where all values are null). Return them alongside `ConflictAll.OnlyOne`.

**`FieldDiff` — per-cell ConflictThis (Bug 2)**
- [ ] Add `IReadOnlyDictionary<string, ConflictThis> CellStates` to `FieldDiff` — one entry per plugin, for this specific field.
- [ ] `ConflictClassifier` computes `CellStates` per field using the field-level winner algorithm:
  - Master plugin → `Master`
  - Plugin value is null/absent → omit from `CellStates` (no key, no color)
  - Plugin value equals master value → `IdenticalToMaster`
  - Plugin is the field winner (highest load-order plugin with a non-null value for this field) and no other non-master plugin has a different non-null value → `Override`
  - Plugin is the field winner and at least one other non-master plugin has a different non-null value → `ConflictWins`
  - Plugin is not the field winner, and the field winner's value differs from this plugin's value → `ConflictLoses`
  - Plugin is not the field winner, and the field winner's value equals this plugin's value → `Override`
- [ ] The field winner may differ from the record-level winner (e.g. record winner has a null/absent value for a field).
- [ ] `CompareOverride.ConflictThis` (per-plugin per-record) is kept for column header display — it remains the aggregate of per-field states (worst ConflictThis across all fields for that plugin, or the existing record-level computation).
- [ ] Run `npm run generate-api` after any model change.

## Webview

**Cell coloring (Bug 2)**
- [ ] `FieldDiff.cellStates` (camelCase in TypeScript) drives each cell's `backgroundColor` and `color`.
- [ ] Per-cell colors:

  | ConflictThis | backgroundColor | color |
  |---|---|---|
  | IdenticalToMaster | `rgba(150,150,150,0.18)` | default |
  | Override | `rgba(76,175,80,0.18)` | default |
  | ConflictWins | `rgba(255,152,0,0.18)` | default |
  | ConflictLoses | `rgba(244,67,54,0.18)` | `rgba(244,67,54,1)` (red text) |
  | absent (no key) | none | default |
  | Master, OnlyOne | none | default |

- [ ] Column headers continue to use `CompareOverride.conflictThis` for their background (the per-record summary).
- [ ] Row background continues to use `conflictAll`.
- [ ] Remove the current column-level cell coloring (`getColBg(o.conflictThis)` applied to data cells).

**Single-plugin display (Bug 1)**
- [ ] No webview change required if the backend returns non-empty diffs for OnlyOne records. Confirm fields render.

## Tests

**C# — `ConflictClassifierTests`**
- [ ] Single plugin with fields → `diffs` is non-empty, each diff has a single-entry `CellStates` with `ConflictThis.OnlyOne` for that plugin (or omit; decide and be consistent with the webview rendering for OnlyOne cells).
- [ ] Two plugins, field where non-master matches master → `CellStates[nonMaster] = IdenticalToMaster`.
- [ ] Two plugins, non-master changes field uncontestedly → `CellStates[nonMaster] = Override`.
- [ ] Three plugins, two non-masters disagree on a field → winner gets `ConflictWins`, loser gets `ConflictLoses`.
- [ ] Field winner differs from record winner: record winner has null for a field; a mid-stack plugin set it → that mid-stack plugin is the field winner and gets `Override` for that field (not `ConflictLoses`).
- [ ] Absent field (null in non-master): no key in `CellStates` for that plugin+field.

**Webview — `RecordPanel.test.tsx`**
- [ ] OnlyOne record (single override, non-empty diffs): field rows are rendered.
- [ ] Conflict record: ConflictLoses cell has red `backgroundColor` and red `color`.
- [ ] Conflict record: ConflictWins cell has orange `backgroundColor`.
- [ ] Override record: Override cell has green `backgroundColor`.
- [ ] Row `backgroundColor` reflects `conflictAll` (orange for Conflict, green for Override).
- [ ] Column header `backgroundColor` reflects `CompareOverride.conflictThis`.

## Proof

*To be filled in on completion.*
