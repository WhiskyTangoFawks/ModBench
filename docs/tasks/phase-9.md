# Phase 9 — Conflict Classification

**Status: Complete**

*Goal: users see the two-axis conflict state (ConflictAll per record row, ConflictThis per plugin column) in the compare grid, with xEdit-style color coding.*

Model decided in ADR-0016. See CONTEXT.md for full enum definitions. Filtering records by conflict state is deferred to its own phase and will be derived from the DuckDB records table via SQL at query time — no precomputed conflict table.

**Tier 1 (this phase):** ConflictAll and ConflictThis classification without ConflictPriority field metadata. ConflictBenign and ConflictCritical states require ConflictPriority (Tier 2, Phase 9.5).

**Tier 1 ConflictAll values:** OnlyOne, NoConflict, Override, Conflict

**Tier 1 ConflictThis values:** OnlyOne, Master, IdenticalToMaster, Override, ConflictWins, ConflictLoses

## Backend

**Enums**
- [ ] Add `ConflictAll` and `ConflictThis` C# enums (Tier 1 values only) to `MEditService.Core/Queries/`

**Classifier (`MEditService.Core/Queries/ConflictClassifier.cs`)**
- [ ] Replace `ComputeDiffs()` with `Classify()` returning `(ConflictAll recordState, IReadOnlyList<FieldDiff> diffs)` where each `FieldDiff` carries `ConflictThis winnerThis` and `ConflictThis loserThis` instead of `isConflict: bool`. Inputs are unchanged — `IReadOnlyList<RecordDetail>` sourced from DuckDB, same as today.
- [ ] Algorithm — ConflictAll:
  - `OnlyOne`: single plugin in the stack
  - `NoConflict`: all plugins agree on all fields (pure ITMs)
  - `Override`: some plugins change fields from master but no two plugins disagree on the same field
  - `Conflict`: two or more plugins set the same field to different values
- [ ] Algorithm — ConflictThis (per plugin):
  - `OnlyOne`: single plugin in the stack
  - `Master`: load-order position 0 for this FormKey
  - `IdenticalToMaster`: all field values match the master's values
  - `Override`: changes at least one field from master; no later plugin contradicts any of those fields
  - `ConflictWins`: is the last (winning) plugin and at least one earlier plugin set the same field differently
  - `ConflictLoses`: changed at least one field, but the winner sets that field to a different value
- [ ] PartialForm null treatment: a null field value in a non-master plugin row means that field is absent from that override. Absent fields are excluded from comparison — null in a non-master row does not generate ConflictLoses.

**Compare response**
- [ ] Add `ConflictAll conflictAll` to `CompareResult`
- [ ] Add `ConflictThis conflictThis` to `RecordDetail` (one per plugin column)
- [ ] Update `GET /records/{fk}/compare` to return the new fields (run `npm run generate-api` after)

## Webview

**Row coloring (ConflictAll)**
- [ ] No color: OnlyOne, NoConflict
- [ ] Green row background: Override
- [ ] Orange row background: Conflict

**Column coloring (ConflictThis)**
- [ ] No color: Master, OnlyOne
- [ ] Grey cell background: IdenticalToMaster
- [ ] Green cell background: Override
- [ ] Orange cell background: ConflictWins
- [ ] Red cell background: ConflictLoses

**PartialForm column**
- [ ] Absent fields (null in a non-master column) render as an empty cell with no background color — not as a blank value
- [ ] Column header shows an italicised "partial" badge when the plugin's record is a PartialForm

## Tests

- [ ] `ConflictClassifier`: single plugin → `ConflictAll=OnlyOne`, `ConflictThis=OnlyOne`
- [ ] `ConflictClassifier`: two plugins, all fields identical → `ConflictAll=NoConflict`, both `ConflictThis=IdenticalToMaster` (non-master)
- [ ] `ConflictClassifier`: two plugins, one changes a field the other doesn't touch → `ConflictAll=Override`, changing plugin `ConflictThis=Override`
- [ ] `ConflictClassifier`: two plugins disagree on a field → `ConflictAll=Conflict`, winner `ConflictThis=ConflictWins`, loser `ConflictThis=ConflictLoses`
- [ ] `ConflictClassifier`: null field in non-master row does not produce ConflictLoses (PartialForm absent-field rule)
- [ ] Webview: row background reflects ConflictAll; plugin column reflects ConflictThis

## Proof

**dotnet test:** Passed — 267 tests, 0 failures

**npm run test:unit:** 109 tests across 13 files, 0 failures

**Notes:**
- `ValuesEqual()` helper added to handle `JsonElement` fields (array/struct) which don't override `Equals()` — fixes false `Override` classification for identical array/struct values
- `generated/api.ts` is stale and needs `npm run generate-api` against the running backend; the webview uses hand-written `types.ts` directly so there is no runtime impact
- 6 pre-existing mutation survivors in `RecordQueryService.cs` (winnerOnly booleans, OrderBy, exception message strings) left unresolved — require multi-plugin fixture or exception message assertions to kill

**Working tree (uncommitted at time of completion)**
