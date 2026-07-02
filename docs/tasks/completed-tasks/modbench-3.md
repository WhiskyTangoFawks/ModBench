# Modbench-3 — File conflict index & status badges (was M-2)

**Status: Complete**
**Recommended model: Sonnet 4.6** — well-defined algorithms (priority winner map, badge rules, TES4 header parse); moderate complexity, clear spec.

*Goal: compute the effective merged mod view (the same priority merge a VFS performs) and surface per-mod status.*

Spec: [mod-manager.md](../mod-manager.md) (Feature Specs §4 "Conflict Index", §5 "Status Checks"). Prereq: Modbench-2. Effort: ~3 days.

> **Planning prerequisite — request screenshots.** No MO2 screenshots were available; badges use plain VS Code `ThemeIcon`s (`warning`/`error`) + tooltip text instead of MO2-matched iconography — a documented deviation, confirmed with the user before implementation.

## Extension

- [x] `FileConflictIndex` — `winner[relativePath] = absolute path in highest-priority enabled mod`; built on load, rebuilt on enable/disable/reorder (via `ModListProvider.refresh()`, called by every mutating command). BA2/BSA files are ordinary entries. Also excludes `meta.ini` (never deployed by MO2 — an intentional deviation from the spec's naive `walk()` pseudocode, otherwise every mod would spuriously conflict on it).
- [x] `StatusChecker` — per-mod badges computed on index build: No conflicts / ⚠ N conflicts / ⚠ Overrides N / ✗ Missing master / ✗ Missing mod (↓ Update available deferred to Modbench-8, as spec'd).
- [x] `MasterReader` — tiny TES4-header read for a plugin's master list (no Mutagen), to detect missing masters.
- [x] Hover tooltip listing conflicting files and the winner.
- [x] File-level conflicts (here) stay distinct from record-level conflicts (`IConflictClassifier`, Editing context) — untouched, separate module.

Missing-master vanilla detection reads MO2's own `gamePath` (`ModOrganizer.ini`) rather than a new `GameDirectory` module (deferred out of Modbench-2, not resurrected here) — generic across all Mutagen-supported games, no hardcoded master names.

## Tests

- [x] Unit: `FileConflictIndex` resolves the winner for an overridden file by priority (explicit regression test for the reverse-priority-iteration merge); rebuilds on reorder.
- [x] Unit: `StatusChecker` reports conflict counts and missing-master/missing-mod correctly against a fixture instance.
- [x] Unit: `MasterReader` extracts the master list from a TES4 header fixture.
- [x] Unit: `StatusChecker` tolerates a malformed/unparseable plugin file without throwing (found during code review — an unguarded `readMasters()` call could blank the entire Mod List tree over one bad file).

## Proof

**Commit:** `b74ecf1`

**Unit tests (376/376):**

```text
Test Files  29 passed (29)
      Tests  376 passed (376)
```

**Integration tests (4/4):**

```text
✔ registers all expected commands on activation
✔ opens a new webview tab when no panel exists
✔ reuses the existing panel on a second call
✔ updates the panel title when opened for a different record
4 passing (4s)
```

**Notes:**

- `/code-review`'s 8 parallel finder agents hit the session rate limit and returned no results; a manual self-review was performed instead and found one real bug (unguarded `readMasters()` in `StatusChecker`, fixed — see commit).
- Manual dev-host visual verification (warning icons + conflict tooltips against the `conflict-instance` fixture) was launched but not yet confirmed by the user at task completion time — pending.
