# Phase 13.3 — VMAD Read-Only Display (with conflict coloring)

**Status: Not Started** · Parent: [phase-13](phase-13.md) · Depends on: 13.2 · **Model: Sonnet** *(reuse-heavy React component; backend supplies pre-aligned data, no re-derivation)*

*Goal: VMAD appears in the compare grid as a dedicated section below the normal field rows — scripts as sorted rows, properties as sub-rows, struct/array values expandable, **conflict-colored per cell** — following the unified tree model (ADR-0019). Read-only; no edit affordances yet.*

This is the last subphase of the read-only foundation. After it, the original Phase 13 goal (minus deferral) is met, with full conflict highlighting.

---

## Types

- [ ] `npm run generate-api` (from 13.2) produced the aligned-diff types `VmadCompare` / `VmadScriptDiff` / `VmadPropertyDiff` and the `vmad` field on the compare response. These mirror `FieldDiff` (per-plugin `Values`, per-plugin `CellStates`), so they consume the same way generic diff rows do. Surface them through whatever local view-model mapping `RecordPanel` uses (see [webview/src/types.ts](../../medit-vscode/webview/src/types.ts) and how `CompareResult` / `FieldDiff` are consumed).

## Component

A new `VmadSection` component in `webview/src/`, rendered by [RecordPanel.tsx](../../medit-vscode/webview/src/RecordPanel.tsx) below the diff rows. Reuse the existing grid layout primitives (the `baseCell` styles, column set, `getCellStyle`, expand/collapse toggle pattern from `DiffRow`).

- [ ] **Section header row** spanning the grid: "Scripts (VMAD)". Omit the entire section when the compare response's `vmad` field is absent/empty (empty state).
- [ ] **Script rows** — driven by `VmadScriptDiff` (already aligned & sorted by the backend). The plugin column shows the script's `Flags`; empty when that plugin has no script with that name. Expand toggle reveals its properties.
- [ ] **Property sub-rows** — driven by `VmadPropertyDiff` (aligned & sorted). Each plugin column shows the value rendered per `Kind`:
  - scalar (Bool/Int/Float/String) → plain text.
  - object → FormKey rendered as a link (reuse the FormKey link rendering used by `FormKeyCell` in read mode); show alias if present (`FormKey [Alias N]`).
  - array → collapsed summary `[N items]`, expandable into element sub-rows (`Children`, index-aligned).
  - struct → expandable into member sub-rows (`Children`, recursive).
  - structList → expandable into per-struct groups, each expandable into members.
  - variable → render `(Variable)` / `(N variables)` placeholder text, never expandable.
- [ ] **Per-cell conflict coloring** — apply `getCellStyle(cellStates[plugin])` to every script cell, property cell, and nested member/element cell, exactly as `DiffRow` does for generic fields. The backend (13.2) supplies `CellStates`; this subphase renders them. Type differences across plugins (carried in `Types`) should be visibly distinguishable (e.g. show the differing type next to the value).
- [ ] **Pending column** for VMAD: always empty here (editing starts in 13.4/13.5).
- [ ] **Edit mode** shows no edit affordances in the VMAD section in this subphase. The section renders identically in read and edit mode (but conflict coloring is present in both, like generic rows).

> The backend already aligns scripts/properties/members across plugins (13.2). The frontend renders the supplied diff rows + cell states; it does not re-derive alignment. Reuse `getCellStyle` and the expand/collapse pattern from `DiffRow` / `StructRowGroup`.

---

## Tests (`npm run test:unit`, Vitest + RTL)

- [ ] VMAD section renders a script-name row and, when expanded, its property sub-rows.
- [ ] An Object property renders its FormKey as a link with the alias.
- [ ] A scalar-array property renders `[N items]` and expands to N element rows.
- [ ] A Struct property expands to its member rows.
- [ ] A conflicted property cell (non-winner `ConflictThis` in `CellStates`) gets conflict styling; an equal cell does not.
- [ ] The VMAD section is absent when the compare response has no `vmad` (record without VirtualMachineAdapter).
- [ ] Edit mode renders the VMAD section with no inputs (read-only invariant for this subphase), conflict coloring still present.

---

## Proof

*To be filled in on completion. Paste `npm run test:unit` output and commit hash.*
