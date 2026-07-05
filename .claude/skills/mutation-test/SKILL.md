---
name: mutation-test
description: Run Stryker.NET mutation tests against MEditService.Core and triage survivors.
---

# Mutation Test

Stryker.NET mutation tests against `MEditService.Core`. Commands from `MEditService/`.

## Role

This is a **specification-audit and entropy-control tool, not a coverage/score gate.**
In a TDD-first, agent-written codebase a survivor asks *"does this code matter / is it
specified?"* — read survivors the way a reviewer reads a PR: *show me what doesn't
appear to matter.* The highest-value answers are usually **delete** and **accept as
unproductive**, not "add a test."

**Success = every survivor has a recorded disposition, not zero survivors.** A run that
ends with documented accepts is a pass. `parse-report.py` exiting 1 means *survivors
await disposition*, not *failure*. Do **not** write a mutant-targeted micro-test just to
force a kill — that re-introduces the implementation-coupling TDD exists to prevent.

> ⚠️ **Run `run.sh` foreground, exactly as documented.** Never as an agent background task
> (`run_in_background`) — the harness SIGKILLs the task's process group, which kills the terminal
> window `run.sh` spawns and can take VS Code down with it. Never `pkill`/`kill` host processes
> (especially `pkill dotnet` — it kills VS Code's C# servers). The opened terminal tails Stryker's
> raw TTY output; the agent only waits for the script to return and reads the printed summary —
> raw Stryker output never enters agent context.
>
> ⚠️ **Do not re-add `"progress"` to `stryker-config.json` reporters.** ShellProgressBar crashes
> with `ArgumentOutOfRangeException` (negative string length) when Stryker runs inside the PTY
> that `script -q -c` creates — the default PTY width triggers the bug. `"json"` alone is
> sufficient; `run.sh` parses the report and prints the summary.

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

**Ask the gating question first, for every survivor:**
*Is there a user-visible requirement this code/line serves?* The answer routes the
triage. `NoCoverage` ≠ `Survived`: `NoCoverage` skews toward a real gap (#6); a
covered-but-`Survived` mutant skews toward "code that doesn't matter" (#1/#5) — the
entropy signal you most want to act on.

**Record exactly one disposition per survivor** using this order (stop at first that applies):

1. **Delete** — no requirement; guards impossible/unreachable state → remove it.
2. **Refactor duplicate** — logic duplicated → make reusable, cover once.
3. **Simplify** — overcomplicated (e.g. `?? ""` on non-nullable) → simplify so the mutant ceases to exist.
4. **Fix coupling smell** — code *is* covered but the test asserts mechanism, not outcome (survives despite coverage) → rewrite the assertion to check observable behavior.
5. **Accept (unproductive)** — code is needed as a defensive invariant at a trust boundary, with no user-visible behavior a test could assert → record the invariant **and** why no requirement-level test can observe it; **propose** a suppression (batched for developer approval — see `/validate` Step 4/5). Do not apply it mid-task.
6. **Real red-green** — a genuine user-visible behavior is unspecified/untested → identify the feature, get the requirement, and run a proper feature-level red-green cycle. **Never** a mutant-targeted micro-test.
7. **Request a fixture** — the guard handles **malformed/edge-case plugin data** on a Mutagen-facing seam that you cannot synthesize (the error requires bad binary data). The code is likely genuinely needed — do **not** delete or blind-accept. Ask the developer to supply a plugin exhibiting the condition, then write a real behavioral test against it. Ledger entry: `request-fixture:<condition>`; this survivor is paused until the fixture arrives.
8. **Refactor seam** — behavior real but no test writable (hidden dependency) → expose the seam.
9. **Equivalent mutant** — mutation cannot change observable behavior → record as accept/equivalent.

**Never suppress without explicit developer approval.** Suppression (below) is the
mechanism that makes an **Accept (#5)** or **Equivalent (#9)** durable so it stops
re-surfacing — it still requires a reason and developer sign-off. Only logging may go
untested by default — handled via `stryker-config.json`, never comment annotations.

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

## Test-smell taxonomy

Shared vocabulary between mutation triage (#4 *Fix coupling smell*) and test review. A
surviving mutant on covered code usually points at one of these; use the same names when
flagging or auditing tests. Be conservative — flag genuine smells with concrete evidence,
not style nits.

- **mechanism-not-outcome** — asserts internal call counts / intermediate state / private structure instead of observable behavior (`retries == 3`). Backend flavour: asserting on internal repository calls or intermediate DTO shape rather than the queried/saved result.
- **vacuous** — no assertion; only "does not throw"; or asserts a value it just set / a construction that cannot fail.
- **over-mocking** — mock verifies mock; the test proves the wiring it declared, not real behavior.
- **coupled-literals** — exact strings, magic numbers, or ordering the spec never constrained (brittle to refactor).
- **redundant** — multiple tests exercising the same behavior; collapse candidates.
- **multi-behavior** — several unrelated behaviors asserted in one test, obscuring intent.
- **testing-the-framework** — exercises Mutagen/DuckDB/library behavior rather than our own logic.

## Known issues

- `CompileError` mutants from `DuckDbRecordRepository.Index` and `SchemaReflector.GetSubFieldInfo` are expected — Stryker can't mutate `out` variable patterns there. Counted and ignored automatically.
