# Phase 9.5 — Conflict Classification Tier 2: ConflictPriority Refinements

**Status: Not Started**

*Prerequisite: Phase 9 (Tier 1 classifier working). Goal: match xEdit's field-priority-aware conflict detection for the common cases that affect every load order.*

This phase requires building a lookup table of `(record_type, field_name) → ConflictPriority` derived from the xEdit definition files in `TES5Edit/Core/wbDefinitionsFO4.pas`. The priority values change which differences register as conflicts and which are silently benign.

## Backend
- [ ] Build `ConflictPriorityTable`: a static `Dictionary<(string recordType, string fieldName), ConflictPriority>` populated by parsing the xEdit definitions or hand-extracted from them. Key entries: `cpIgnore` fields (XLRT, PNAM/FNAM on some records), `cpBenign` fields, `cpBenignIfAdded` (XLRL Location Reference on REFR/CELL/WRLD records)
- [ ] `ConflictClassifier` consults `ConflictPriorityTable` per field before comparing: skip `cpIgnore` fields entirely, cap results at `ConflictBenign` for `cpBenign` fields, apply `cpBenignIfAdded` logic (benign only when absent in master)
- [ ] Sorted array detection: mark known sorted arrays (Script Properties, Quest Aliases, Door Links, Weather Types) so the classifier matches elements by sort key rather than by array index before comparing
- [ ] Injected record detection: if a record's FormKey origin plugin is not a declared master of the override plugin, treat as `cpCritical` and bump to `ConflictCritical`

## Tests
- [ ] `cpIgnore` field (e.g. XLRT on a REFR record) does not contribute to ConflictAll even when values differ
- [ ] `cpBenignIfAdded` field (XLRL) is ConflictBenign when absent in master, ConflictNormal when present and differing
- [ ] Injected record receives ConflictCritical
- [ ] Sorted array: two overrides that sort to the same order are NoConflict regardless of insertion order

## Proof

*To be filled in on completion. Paste `dotnet test` output and commit hash here.*
