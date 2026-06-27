# Follow-up: mutation-test workflow needs rework

**Status: RESOLVED (2026-06-27).** Root cause confirmed: all 139 Timeout mutants were on the
indexing/schema path, co-covered by `RealGameLoadTests` loading the 316 MB real `Fallout4.esm`,
which inflated every indexing mutant's timeout budget. Fixes shipped:
- Removed the 316 MB real-game test from the suite; real-data coverage now comes from a small
  committed plugin `MEditService.Tests/TestData/mEditTestSubset.esm` (regen via
  `RealData/CutDownPluginGenerator.cs`) — hermetic, fast, stays in mutation scope.
- Full-install smoke test (`RealData/RealInstallSmokeTests.cs`) auto-discovers installs (no
  hardcoded path, multi-game ready) and is gated behind `MEDIT_SMOKE=1` so it never runs under
  mutation.
- Stryker: added `progress` reporter (developer-facing `%` in the terminal); reverted
  `concurrency` to default so the machine stays usable.
- `/validate` Step 5 + `/mutation-test` updated: targeted mutation per subtask, one full
  changed-scope run at phase end, confirm survivors with targeted runs only (never full re-run).

Original analysis retained below for reference.

---

**Status: Open follow-up. Not blocking — Phase 16.1 shipped without a confirming
mutation re-run (see "What's verified" below).**

Two distinct problems surfaced during Phase 16.1 validation: (1) an agent (Opus) broke the
host environment by running the mutation skill the wrong way, and (2) the mutation run is now
slow enough (~an hour) that the current `/validate` loop — which assumes you can re-run it
after each triage fix — is no longer viable.

## Problem 1 — running `run.sh` "cleverly" took down VS Code

`run.sh` contains **no kill logic** (its only `EXIT` trap is `restore_config; rm -f
"$TTY_LOG"`). It is designed to be run **foreground, by a human, from a terminal**: it spawns
a **desktop GUI terminal window** (`cosmic-term` on this COSMIC machine; falls back to
gnome-terminal/xterm) plus a `script` PTY wrapper around `dotnet stryker`, so the human can
watch live progress.

What broke it:analyse
- The agent ran `run.sh` as an **agent-managed background task** (`run_in_background: true`).
  The harness tracks background tasks by **process group** and SIGKILLs the whole group on
  teardown (task stopped, or the Claude Code process exits). That group contained the spawned
  `cosmic-term`; because the agent runs **inside the VS Code extension host**, the group/session
  teardown rippled up and **closed VS Code**. The script had already returned exit 0 — the kill
  happened during task teardown *afterward*, matching the observed "finished, exit 0, then VS
  Code died."
- Separately, while trying to clean up an orphaned run, the agent ran **`pkill -9 dotnet`**,
  which unconditionally kills VS Code's C# extension `dotnet` processes (Roslyn LanguageServer,
  csdevkit). **Never do this** — it kills the editor's tooling.

**Rule for agents (what Sonnet does and it "just works"): invoke the mutation skill exactly as
documented — foreground, no `run_in_background`, no GUI-terminal expectations, and never
`pkill dotnet`/`kill` host processes.** If an agent must run Stryker without a GUI window,
invoke `dotnet stryker --config-file stryker-config.json` directly (no `run.sh` wrapper, so no
`cosmic-term` spawn) and parse `StrykerOutput/**/reports/mutation-report.json` afterward.

## Problem 2 — mutation runs are ~1 hour; the re-run loop is impractical

`/validate` Step 5 implies: run mutation → triage survivors → **re-run to confirm**. With the
corpus grown to ~an hour per run, re-running 2–3 times across a validation pass costs most of a
day. This needs a workflow redesign. Options to evaluate:

- **Don't full-re-run to confirm.** Run the full pass **once**; confirm individual triaged
  survivors with **targeted** runs only: `run.sh --file <File>.cs` or
  `run.sh --mutant-ids <id> <id>` (already supported — see `run.sh` arg parsing). A handful of
  targeted mutants run in seconds, not an hour.
- **Investigate the runtime.** The Phase 16.1 baseline run had **139 Timeout** mutants out of
  ~785 tested — timeouts each cost the full timeout window and dominate wall-clock. Worth
  finding which tests/mutants hang under mutation and tuning `additional-timeout` /
  excluding pathological spots, or raising `concurrency`.
- **Reconsider when mutation runs at all.** Possibly move it out of the inline `/validate` loop
  into a pre-merge/CI step the human kicks off, with `/validate` relying on the unit suite +
  code-review and a *targeted* mutation check on just the changed methods.

## Reference data — Phase 16.1 baseline run (StrykerOutput/2026-06-26.06-12-47)

Score **74.0%** (changed-files scope, `since: main`):
Killed 473 · Survived 27 · Timeout 139 · NoCoverage 2 · CompileError 534 · Ignored 1809.

Survivors were all in the three new/changed files and were triaged **after** this run:

| File | Mutants | Triage action (this branch) |
|------|---------|------------------------------|
| `WorldspaceQueryService.cs` | 45/51 OrderBy/ThenBy ordering; 47 `BlockY ?? 0`; 28 NoCoverage `GetWorldspaces` | Added `GetWorldspaceBlocks_SortsBlocksAndSubBlocksAscendingByXThenY` + `GetWorldspaces_MapsRecordsToSummaries` |
| `WorldspaceQueryService.cs` | 72 `_session.Repository ?? throw` | Added `WorldspaceQuery_NoSession_ThrowsInvalidOperation` (reachable no-session path) |
| `PlacementWalker.cs` | 43 NoCoverage (TopCell) | Fixture now sets `wrld.TopCell` + asserts its row |
| `PlacementWalker.cs` | 119 `Int(v)` null branch | **Deleted** — dead guard; helpers are never called with null (block/sub are non-nullable; grid/pos guarded at call site) |
| `DuckDbRecordRepository.cs` | 739–745, 772–774, 806–807 reader `IsDBNull ? null : Get` | Fixture now has null + non-null variants per column (bare cell, no-grid cell, null-editorId/Base ref) |
| `DuckDbRecordRepository.cs` | 400 `n.Members ?? []` | **Pre-existing VMAD** code, untouched by this feature; left as-is, out of scope |

**To confirm without a full re-run:** targeted runs of the two changed Core files —
`bash ../.claude/skills/mutation-test/run.sh --file WorldspaceQueryService.cs` and
`--file PlacementWalker.cs` — plus `--mutant-ids` for the `DuckDbRecordRepository.cs` reader
lines listed above. Expected remaining survivor: only the pre-existing VMAD `:400`.

## What's verified for Phase 16.1 without the confirming mutation run

- `dotnet test` — **723 passing** (incl. the strengthened placement/worldspace tests).
- `npm run test:unit` — 261 passing; integration 4 passing; `npm run build` clean.
- `/simplify` and `/code-review` (high) completed; no confirmed bugs.

The confirming mutation re-run is deferred to a manual run by the developer per this follow-up.
