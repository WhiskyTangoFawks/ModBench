---
status: accepted
---

# Two-axis conflict model (ConflictAll + ConflictThis)

Decided 2026-06-02; extended 2026-08-11.

## Context

An early four-state conflict model (No Override, Override, Change Lost, Conflict) was derived from xEdit's visible UI states.

Investigation of the TES5Edit source (`xeMainForm.pas`, `wbInterface.pas`, `wbImplementation.pas`) revealed that xEdit actually tracks conflict state on **two independent axes**:

- **ConflictThis** — this plugin's version of the record relative to the rest of the stack. Classifies each cell in the compare grid individually.
- **ConflictAll** — the summary classification for the entire override stack. Classifies each row (record) as a whole.

The two axes are separate because a record's overall status (`ConflictAll`) and any given plugin's specific contribution (`ConflictThis`) are different questions. A record may be a `caConflict` overall while the master plugin's version is `ctMaster` and the winning plugin's version is `ctConflictWins`.

Our original four states are actually a subset of `ConflictAll`. Implementing only the four-state model would prevent per-cell color coding and conflate "the record has a conflict" with "this plugin is the conflict winner/loser" — two UI concepts that drive different actions.

### xEdit's full enum sets (verified from source)

`TConflictAll` (row-level, background color):
- `caUnknown` — not yet computed
- `caOnlyOne` — record exists in one plugin only
- `caNoConflict` — all overrides agree on all fields
- `caConflictBenign` — differences exist but all are marked low-priority (cosmetic/redundant)
- `caOverride` — one plugin overrides but the change is uncontested
- `caConflict` — two or more plugins disagree; last-wins
- `caConflictCritical` — injected records or fields explicitly marked critical are in conflict

`TConflictThis` (per-plugin cell, font color / cell background):
- `ctUnknown` / `ctNotDefined` — structural absence / not computed
- `ctIgnored` — field has `cpIgnore` priority; excluded from conflict logic
- `ctOnlyOne` — single-plugin mode
- `ctMaster` — this is the originating (first-in-stack) plugin
- `ctIdenticalToMaster` — same values as the master; benign override
- `ctConflictBenign` — differs but priority-capped at benign
- `ctOverride` — uncontested override (different from master but no one else changes it)
- `ctConflictWins` — wins the conflict (last plugin to change this field)
- `ctConflictLoses` — loses the conflict (overwritten by a later plugin)

### ConflictPriority modifies the outcome in xEdit

Every field definition in xEdit carries a `ConflictPriority` that the algorithm consults before classifying:

| Priority | Effect on detection |
|---|---|
| `cpIgnore` | Field excluded from conflict detection entirely |
| `cpBenign` | Differences capped at `caConflictBenign` / `ctConflictBenign` |
| `cpBenignIfAdded` | Treated as benign if absent in the master (used on XLRL Location Reference) |
| `cpNormal` | Standard comparison |
| `cpNormalIgnoreEmpty` | Master absence treated as non-conflicting (used on DOBJ, actor templates) |
| `cpOverride` | Per-plugin result capped at `ctOverride` (no red cell) |
| `cpCritical` | Bumps to `caConflictCritical` if non-empty values differ |

Injected records (FormKey from a master the plugin doesn't formally declare) are automatically treated as `cpCritical`.

### Comparison uses resolved display values, not raw binary

xEdit compares `DisplaySortKey` values — the human-readable resolved form — not raw bytes. Two records can have different binary representations but be considered identical (e.g. a FormID that resolves to the same target across different load-order slots).

### PartialForm records are sparse by design

A record with the `IsPartialForm` header flag intentionally omits fields it doesn't override. These absent fields are treated as `cpIgnore` in conflict detection — not as "empty values that differ from the master." Displaying partial-form absent fields as blank cells would mislead users into thinking the plugin is explicitly setting those fields to null.

### Sorted vs unsorted arrays

`wbArrayS` (sorted) arrays in xEdit must be matched by sort key before comparing elements, not by array index. Positional mismatch between two versions of a sorted array is not a conflict — the arrays just need to be sorted first. For unsorted arrays (e.g. quest script fragments: OnBegin, OnEnd, OnChange), order is semantically significant and positional mismatch is a real conflict.

## Decision

**Adopt the two-axis model.** Every override-stack computation produces both a `ConflictAll` for the record and a `ConflictThis` for each plugin's version. Both are returned by the API and used in the UI.

**Implemented:**

- Full two-axis classification using Mutagen field values for comparison. `ConflictThis` and `ConflictAll` values match xEdit semantics for the common cases (identical-to-master, override, conflict wins/loses).
- Injected record detection: if an override plugin's master list does not include the FormKey's origin plugin, the record is flagged `ConflictCritical`. This is a game-agnostic structural check that does not require a priority table.

  **Correction (2026-07-09):** this note originally described the check as unconditional. Re-tracing `xeMainForm.pas` (`ConflictLevelForNodeDatas`) showed xEdit only escalates an injected record to `caConflictCritical` when the base classification is already `caOverride`/`caConflict` (a real non-empty value difference exists); a content-identical injected record stays `caNoConflict`. `ConflictClassifier` was fixed to match — see the issue that reconciled this with `CONTEXT.md`'s "injected record in conflict" wording.
- Sorted array order-independent comparison: driven by `FieldMetadata.ElementType.IsSortable` (set by `SchemaReflector` for FormLink arrays), not a lookup table. Two sorted arrays with the same elements in different order do not register as a conflict.

**Not implemented — `ConflictPriority` table:**

Investigation revealed that xEdit's `ConflictPriority` system exists because xEdit operates at the raw binary level and must paper over redundant count fields, unused bytes, and internal bookkeeping that appear in the raw record structure. Mutagen abstracts all of that away — those fields simply do not appear in the DuckDB schema. A `ConflictPriority` table would annotate fields that do not exist in our system and would never be consulted. The cpIgnore/cpBenign/cpCritical branches were accordingly removed.

**Final enum values:**

`ConflictAll`: `OnlyOne`, `NoConflict`, `Override`, `Conflict`, `ConflictCritical`

`ConflictThis`: `OnlyOne`, `Master`, `IdenticalToMaster`, `Override`, `ConflictWins`, `ConflictLoses`

**Do not implement a five-state or six-state simplification.** The temptation to flatten the two axes into a single summary is strong, but it destroys the per-cell information that makes xEdit's grid readable. The UI needs both axes.

## Implementation notes

- `ConflictClassifier` in `MEditService.Core/Queries/` is the right home. It takes the ordered list of override records — resolved via the read seam (`IRecordReads`; `IRecordRepository` was renamed away by #421) — and returns `(ConflictAll, IReadOnlyList<(plugin, ConflictThis)>)`.
- Comparison should use Mutagen's typed field values where available. Raw bytes are acceptable as a fallback but will miss cases where two representations are semantically equal (FormID slot remapping being the most common).
- The `IsPartialForm` flag on `IFormRecord` must be checked before building override column data; absent fields in a partial form are omitted from the column entirely, not shown as blank.
- `ConflictAll` and `ConflictThis` are cached per FormKey and invalidated on index update (same lifecycle as DuckDB rows today).

## Update (2026-08-11): ConflictAll now has two independent scopes (#114)

The "Decision" section above defines `ConflictAll` as classifying "each row (record) as a whole."
Issue #114 found that the compare grid was applying that one record-wide value unconditionally to
*every* rendered row — every leaf field, every struct member, every array element, at every
nesting depth — so a record with one differing field turned every row of its grid the same color,
including rows where every plugin agreed. That conflated two genuinely different questions: "is
the record's override stack, as a whole, in conflict" (a Plugins-tree badge question) and "does
*this specific field* differ" (a compare-grid row question).

**This extends the model rather than reversing it: `ConflictAll` is now computed at two
independent scopes, both legitimate, neither superseding the other:**

- **Record-wide** (unchanged) — `ClassifyResult.ConflictAll` / `CompareResult.ConflictAll`,
  computed once per record from its top-level fields' cell states. Still exactly what it always
  was: the Plugins-tree's per-record conflict badge, meaning "the record's override stack as a
  whole."
- **Per-node, bottom-up** (new) — `FieldDiff.ConflictAll`, computed once per node in the field-diff
  tree (every leaf, every struct member, every array element, at every depth), using the *same*
  reduction rule (`ConflictRules.Reduce`/`Escalate`) the record-wide value already used, just
  scoped to that one node's own subtree instead of the whole record. A leaf's value comes from its
  own cross-plugin cell states alone. A struct/array node with children aggregates the worst state
  found anywhere in its subtree, recursively — computed by folding its own reduced cell states
  with each already-built child's own (already-aggregated) value, which is mathematically the same
  as reducing the union of every cell state in the subtree in one pass. This is the value the
  compare grid's row background now reads (`docs/specs/medit-record-editor.md`'s "Conflict color
  coding" section).

**Collapsed/expanded rule** (compare grid only, not the Plugins tree): a struct/array row shows its
per-node aggregate tint while **collapsed** — collapsing must not hide the fact that something
inside differs — and shows **no** background of its own while **expanded**, since its now-visible
child rows each carry their own individual tint instead; painting both would duplicate the signal
and misattribute it to fields that didn't actually change.

**No tint on `NoConflict`/`OnlyOne` is a deliberate mEdit divergence, not an oversight.** xEdit's
own default palette tints even its no-conflict row state; mEdit's compare grid deliberately leaves
`NoConflict`/`OnlyOne` unpainted at both scopes so a background color is reserved for "something
here needs attention" — the signal #114 reports was being muddied by the record-wide smear.

VMAD and Condition rows (synthesized by `vmadTreeAdapter.ts`/`conditionTreeAdapter.ts` into the
same `FieldDiff` shape, #231) compute their own per-node `ConflictAll` the same way, in TypeScript
(`recordUtils.ts`'s `reduceConflictAll`/`aggregateConflictAll`, mirroring `ConflictRules.Reduce`/
`Escalate` by hand) — their own backend DTOs (`VmadPropertyDiff`, `ConditionDiff`) carry no such
field, since they're folded into the unified tree entirely on the frontend.

No new colors: both scopes reuse the existing `ConflictAll`→row-background mapping unchanged
(`docs/specs/medit-record-editor.md`); only the granularity at which it's computed and applied
changed.

## Alternatives rejected

**Keep the four-state model** — cannot drive per-cell color coding. The "Change Lost" state (a mid-stack change overwritten by a later plugin) maps to `ctConflictLoses` on a specific plugin column, which requires ConflictThis to exist at all.

**Implement ConflictPriority table** — investigated and closed. The priority system exists because xEdit works at the raw binary level and must paper over redundant count fields, unused bytes, and internal bookkeeping. Mutagen abstracts all of those away — those fields do not appear in the DuckDB schema. The table would annotate fields that don't exist in our system. Closed; not deferred.

**Compute conflict state in DuckDB SQL** — conflict classification requires iterating the override stack in load-order position and comparing field values across rows. DuckDB's `GROUP BY` + `COUNT(DISTINCT value)` approximation would give a binary "agrees/disagrees" per field but cannot produce `ConflictThis` per plugin or distinguish `ctConflictWins` from `ctConflictLoses`. The classification belongs in C# using the full record objects, with results persisted to DuckDB for filtering.
