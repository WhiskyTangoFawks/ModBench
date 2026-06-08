# Phase 9.5 — Conflict Classification Tier 2: ConflictPriority Refinements

**Status: Complete**

*Scope was revised: ConflictPriority table machinery was deemed unnecessary. Implemented sorted array detection and injected record detection only. cpIgnore/cpBenign/cpBenignIfAdded deferred indefinitely — see `docs/tasks/future-explorations.md`.*

## Backend
- [x] Sorted array detection: `IsSortable` flag on `FieldMetadata.ElementType`; classifier collects sortable field names and passes to `ValuesEqual` for order-insensitive comparison
- [x] Injected record detection: `IsInjectedRecord` checks whether any non-master override's masters list omits the FormKey's origin plugin; bumps `conflictAll` to `ConflictCritical`
- [ ] ~~ConflictPriorityTable~~ — deferred; not needed for current scope
- [ ] ~~cpIgnore / cpBenign / cpBenignIfAdded~~ — deferred

## Tests
- [x] Injected record receives `ConflictCritical`
- [x] Partial injection (only some overrides missing origin) → `ConflictCritical`
- [x] Invalid FormKey string → not treated as injected (defensive guard)
- [x] Non-injected record does not bump to `ConflictCritical`
- [x] Sorted array: same elements, different insertion order → `NoConflict`
- [x] Sorted array: different elements → `Override`
- [x] Sorted array: different lengths → `Override`
- [x] Unsorted array: same elements, different order → `Override` (not treated as sorted)
- [ ] ~~cpIgnore field tests~~ — deferred

## Proof

324 backend tests pass. All mutants killed (Stryker exit 0) on `ConflictClassifier.cs`.
Commit: dc9acaa (finish mutation testing remediation)
