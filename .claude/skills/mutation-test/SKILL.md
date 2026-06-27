# Mutation Test

Stryker.NET mutation tests against `MEditService.Core`. Commands from `MEditService/`.

> ⚠️ **Run `run.sh` foreground, exactly as documented.** Never as an agent background task
> (`run_in_background`) — the harness SIGKILLs the task's process group, which kills the terminal
> window `run.sh` spawns and can take VS Code down with it. Never `pkill`/`kill` host processes
> (especially `pkill dotnet` — it kills VS Code's C# servers). The opened terminal is the
> **developer's** live `%`-progress view (`progress` reporter); the agent only waits for the
> script to return and reads the printed summary — raw Stryker output never enters agent context.

> 🏎️ **Confirm fixes with targeted runs, never a full re-run.** A full run can take ~an hour, so
> after triaging a survivor confirm it with `run.sh --mutant-ids <id>` / `--file <File>.cs`. The
> ~316 MB real-game test was removed from the suite (it inflated every indexing mutant's timeout
> budget); real-data coverage now comes from the small committed
> `MEditService.Tests/TestData/mEditTestSubset.esm` (see `RealData/CutDownPluginGenerator.cs`).
> The full-install smoke test (`RealData/RealInstallSmokeTests.cs`) is gated behind `MEDIT_SMOKE=1`
> so it never runs under mutation.

## Running the report

> ⚠️ **Never read `mutation-report.json` directly.** Files are 2–3 MB with full source embedded. Always run `run.sh` (calls `parse-report.py`) — only the summary reaches context.

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh
```

Scope to all Core (disables `since`, full corpus — slow):

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh --all
```

Single file:

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh --file ConflictClassifier.cs
```

Specific mutant IDs (still pays ~60s initial run):

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh --mutant-ids 42 57
```

`run.sh` prints scope before running. Exits 0 if all killed, 1 if any survivors or NoCoverage remain.

Run parser against existing report (re-read without re-running):

```bash
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py StrykerOutput/<dated-run>/reports/mutation-report.json
```

## Handling survivors

Analyze the survivors. Obvious fixes can be dealt with directly. Complexity or architectural refactors should be surfaced to the developer, along with analysis and a recommendation.

**Propose an action for each survivor** using this triage order (stop at first that applies):

- **Delete** — code guards impossible state; remove it
- **Refactor duplicate** If code is duplicated, refactor so code is reusable, and can be covered by single test
- **Simplify** — overcomplicated (e.g. `?? ""` on non-nullable); simplify so mutant ceases to exist
- **Add assertion to existing test** if existing test covers necessary conditions, add assertion.
- **Write a test** — necessary logic; identify the feature, identify what part of the feature is untested, and write a test for the feature.
- **Refactor** — no test writable (hidden dependency, unreachable branch); expose the seam
- **Suppression** — last resort; flag explicitly for developer approval


**Never suppress without explicit developer approval.** Only logging may go untested — handled via `stryker-config.json`, never comment annotations. 

## Suppression format (only after explicit developer approval)

Config-level (preferred):

```json
"ignore-mutants": [
  { "mutant": "StringLiteral", "description": "Logging statements are not tested by design" }
]
```

Source-level (last resort):

```csharp
someCode(); // Stryker disable once StringLiteral: <reason>
```

Prefer config-level for anything project-wide. Annotations without reasoning (why the code exists, why the mutation is inert) will be rejected in review.

## Known issues

- `CompileError` mutants from `DuckDbRecordRepository.Index` and `SchemaReflector.GetSubFieldInfo` are expected — Stryker can't mutate `out` variable patterns there. Counted and ignored automatically.
