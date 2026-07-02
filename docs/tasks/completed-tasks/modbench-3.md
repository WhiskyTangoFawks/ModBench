# Modbench-3 — File conflict index & status badges (was M-2)

**Status: Not Started**
**Recommended model: Sonnet 4.6** — well-defined algorithms (priority winner map, badge rules, TES4 header parse); moderate complexity, clear spec.

*Goal: compute the effective merged mod view (the same priority merge a VFS performs) and surface per-mod status.*

Spec: [mod-manager.md](../mod-manager.md) (Feature Specs §4 "Conflict Index", §5 "Status Checks"). Prereq: Modbench-2. Effort: ~3 days.

> **Planning prerequisite — request screenshots.** Before planning, ask the user for screenshots of MO2's **conflict flags** (the overwrite / overwritten icons) and how per-mod **status** is presented, so the badge + tooltip mapping onto TreeView themed icons matches MO2 rather than being invented.

## Extension

- [ ] `FileConflictIndex` — `winner[relativePath] = absolute path in highest-priority enabled mod`; built on load, rebuilt on enable/disable/reorder. BA2/BSA files are ordinary entries.
- [ ] `StatusChecker` — per-mod badges computed on index build: No conflicts / ⚠ N conflicts / ⚠ Overrides N / ✗ Missing master / ✗ Missing mod / ↓ Update available (the last deferred to Modbench-8).
- [ ] `MasterReader` — tiny TES4-header read for a plugin's master list (no Mutagen), to detect missing masters.
- [ ] Hover tooltip listing conflicting files and the winner.
- [ ] Keep file-level conflicts (here) distinct from record-level conflicts (`IConflictClassifier`, Editing context) — each surfaces in its own view.

## Tests

- [ ] Unit: `FileConflictIndex` resolves the winner for an overridden file by priority; rebuilds on reorder.
- [ ] Unit: `StatusChecker` reports conflict counts and missing-master/missing-mod correctly against a fixture instance.
- [ ] Unit: `MasterReader` extracts the master list from a TES4 header fixture.

## Proof

*To be filled in on completion. Paste `npm run test:unit` output and commit hash here.*
