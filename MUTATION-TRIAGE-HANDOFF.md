# Mutation triage handoff (delete once fully triaged)

## Context

`/validate` Step 4 ran Stryker.NET mutation testing (`.claude/skills/mutation-test/`)
against the 8 `MEditService.Core` files touched by the analyzer-backlog cleanup merged
in `89cb7e2` (main). It surfaced **114 items needing disposition** (90 `Survived`, 24
`NoCoverage`) — far more than expected for a pure style refactor, and out of scope to
triage in that session, so it's being handed off here.

**Read this before triaging anything:** Stryker's `since: main` scoping mutates every
testable line in a *changed file*, not just the lines that actually changed. Every one
of these 8 files got touched somewhere by the mechanical refactor (guard-clause →
conditional expression, naming renames, etc.), so this run amounts to a full mutation
audit of each file's *entire* pre-existing logic, not a check of the refactor itself.
Evidence: survivor counts track file size/complexity almost exactly (see table below),
and spot-checking (e.g. `TypedLinkCacheFactory.cs:23`, the `Assembly.Load` fallback —
never touched by the refactor) confirms untouched logic is showing up as a survivor
right alongside refactored lines. **Do not assume these are regressions from that
refactor** — go in expecting pre-existing coverage entropy, and treat any survivor
that *does* sit exactly on a refactored line as the interesting/higher-priority case.

The refactor itself is not in question: `dotnet test` was 719/719 passing before and
after, independently re-verified multiple times, and `dotnet format --verify-no-changes`
confirmed byte-for-byte equivalence with the analyzer's own fix suggestions.

## Findings by file

| File | Survivors + NoCoverage |
|---|---|
| `Schema/SchemaReflector.cs` | 44 |
| `Edits/PluginWriter.cs` | 41 |
| `Records/DuckDbRecordRepository.cs` | 12 |
| `Queries/VmadConflictClassifier.cs` | 6 |
| `Session/TypedLinkCacheFactory.cs` | 4 |
| `Edits/EditOrchestrator.cs` | 4 |
| `Records/PlacementWalker.cs` | 2 |
| `Queries/ConflictRules.cs` | 1 |

0 `CompileError` mutants this run (the known `Index`/`GetSubFieldInfo` `out`-variable
class from the skill's "Known issues" section didn't trigger here).

## Getting the mutant list (don't re-run Stryker if avoidable)

The full report already exists at:

```
MEditService/StrykerOutput/2026-07-09.12-33-13/reports/mutation-report.json
```

Read it via the parser, never directly (it's 2-3MB with embedded source):

```bash
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py StrykerOutput/2026-07-09.12-33-13/reports/mutation-report.json
```

If that directory has been cleaned since, you'll need to regenerate it. Because this
work is now merged into `main`, `since: main` scoping will find nothing changed — use
one of:

```bash
# Whole Core corpus (~1hr, but the authoritative source of truth)
cd MEditService && bash ../.claude/skills/mutation-test/run.sh --all

# Or scope to just the 8 files above, one at a time (faster, matches this handoff)
cd MEditService && bash ../.claude/skills/mutation-test/run.sh --file SchemaReflector.cs
```

**Read `/mutation-test`'s "Run `run.sh` foreground" warning before running anything** —
never as a background task, never `pkill dotnet`.

## How to triage

Read the `/mutation-test` skill in full before starting — it defines the 9-category
disposition order (Delete → Refactor duplicate → Simplify → Fix coupling smell →
Accept → Real red-green → Request a fixture → Refactor seam → Equivalent mutant) and
the gating question for each survivor: *is there a user-visible requirement this
code/line serves?*

Rules that apply here specifically:
- **Success = every survivor has a recorded disposition, not zero survivors.** Don't
  write mutant-targeted micro-tests just to force a kill.
- **Never suppress without explicit developer approval.** If triage turns up
  candidates for `ignore-mutants` (Accept/Equivalent categories), batch them and ask
  the developer rather than applying suppressions mid-task.
- Given the volume, suggested slicing order: `ConflictRules.cs` (1) →
  `PlacementWalker.cs` (2) → `TypedLinkCacheFactory.cs` (4) →
  `EditOrchestrator.cs` (4) → `VmadConflictClassifier.cs` (6) →
  `DuckDbRecordRepository.cs` (12) → `PluginWriter.cs` (41) →
  `SchemaReflector.cs` (44) — smallest files first to build momentum before the two
  large ones, which likely deserve their own session each.
- Complexity/architectural survivors (categories #6-8) should be surfaced to the
  developer with analysis and a recommendation, not resolved unilaterally.

## Acceptance

- All 114 items have a recorded disposition (not necessarily all fixed — "Accept" and
  "Equivalent" are valid terminal dispositions with developer sign-off).
- Any proposed suppressions are batched and presented for explicit approval before
  being added to `stryker-config.json` or as source annotations.
- Delete this file once triage is complete.
