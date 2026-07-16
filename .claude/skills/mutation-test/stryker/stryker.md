# Stryker.NET — running mutation tests here

Tool-specific mechanics for the `mutation-test` review skill. Stryker.NET mutates
`MEditService.Core`; commands run from `MEditService/`. The review philosophy and triage
live in `SKILL.md` — this file is only *how to run and read the tool*.

## Running the report

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh
```

`run.sh` prints its scope before running, then prints the parsed summary. Exit 0 if all
mutants killed, 1 if any `Survived`/`NoCoverage` remain, 2 on error. Exit 1 means
*survivors await disposition*, not *failure*.

Scopes:

```bash
# default: files changed vs since.target (main), scoped at the FILE level
bash ../.claude/skills/mutation-test/run.sh

# --diff-only: narrow the report to survivors whose lines intersect the git diff.
# This is the /validate Step 4 merge gate ("did THIS diff introduce anything").
bash ../.claude/skills/mutation-test/run.sh --diff-only

# --all: full MEditService.Core corpus, since disabled (slow — can take ~an hour)
bash ../.claude/skills/mutation-test/run.sh --all

# --file: one file, since disabled so it runs regardless of whether the file has a
# diff vs since.target (since-enabled would silently produce zero mutants + no report)
bash ../.claude/skills/mutation-test/run.sh --file ConflictClassifier.cs
```

**Scope is file-level, not diff-level.** Touching one line makes *every* testable line in
that file eligible for mutation — Stryker has no line-level diff filter. This is intentional
(a full entropy audit of files you touch, not a diff-coverage gate), but means survivor
counts on a large touched file can look alarming for a small mechanical change. `--diff-only`
is the narrower "did my actual diff introduce anything new" view.

Re-read an existing report without re-running:

```bash
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py --diff-only
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py StrykerOutput/<dated-run>/reports/mutation-report.json
```

## Guardrails

> ⚠️ **Run `run.sh` foreground, exactly as documented.** Never as an agent background task
> (`run_in_background`) — the harness SIGKILLs the task's process group, killing the terminal
> window `run.sh` spawns and possibly taking VS Code down with it. Never `pkill`/`kill` host
> processes (especially `pkill dotnet` — it kills VS Code's C# servers). The opened terminal
> tails Stryker's raw TTY output; the agent only waits for the script to return and reads the
> printed summary — raw Stryker output never enters agent context.

> ⚠️ **Never read `mutation-report.json` directly.** Files are 2–3 MB with full source
> embedded. Always go through `run.sh` / `parse-report.py` — only the summary reaches context.

> ⚠️ **Do not re-add `"progress"` to `stryker-config.json` reporters.** ShellProgressBar
> crashes with `ArgumentOutOfRangeException` (negative string length) when Stryker runs inside
> the PTY that `script -q -c` creates — the default PTY width triggers the bug. `"json"` alone
> is sufficient; `run.sh` parses the report and prints the summary.

> 🏎️ **Confirm fixes with targeted runs, never a full re-run.** A full run can take ~an hour.
> After triaging a survivor, confirm it with `run.sh --file <File>.cs` and check the specific
> line no longer appears. Even `--file` isn't instant — budget for it. There is **no**
> `--mutant-ids` / `mutant-id` option; Stryker.NET's config schema rejects it (confirmed
> against the installed CLI's `--help` and a live run). An earlier `run.sh` had this flag and
> it never worked — don't re-add it. Use `--file` to confirm a specific fix instead.

## Suppression format

The durable-accept mechanism (see `SKILL.md` §Durable accepts — **only after explicit
developer approval**, always with a reason).

Config-level (preferred, for anything project-wide):

```json
"ignore-mutants": [
  { "mutant": "StringLiteral", "description": "Logging statements are not tested by design" }
]
```

Source-level (last resort):

```csharp
someCode(); // Stryker disable once StringLiteral: <reason>
```

Annotations without reasoning (why the code exists, why the mutation is inert) are rejected
in review. Only logging goes untested by default — via `stryker-config.json`, never comment
annotations.

## Request-a-fixture disposition (Mutagen seams)

`SKILL.md` triage "Request a fixture" applies here when a guard handles **malformed/edge-case
plugin data** on a Mutagen-facing seam you cannot synthesize (the error requires bad binary
data). The code is likely genuinely needed — do **not** delete or blind-accept. Ask the
developer for a plugin exhibiting the condition, then write a real behavioral test against it.
Ledger entry `request-fixture:<condition>`; the survivor is paused until the fixture arrives.

## testing-the-framework here

For the `testing-the-framework` test smell (`SKILL.md` §Test-smell taxonomy): the flavour in
this repo is a test that exercises **Mutagen / DuckDB / library** behavior rather than our own
logic. The backend flavour of `mechanism-not-outcome` is asserting on internal repository
calls or intermediate DTO shape rather than the queried/saved result.

## Known issues

- `CompileError` mutants from `DuckDbRecordRepository.Index` and `SchemaReflector.GetSubFieldInfo`
  are expected — Stryker can't mutate `out` variable patterns there. Counted and ignored
  automatically.
- The full-install smoke test (`RealData/RealInstallSmokeTests.cs`) is gated behind
  `MEDIT_SMOKE=1` so it never runs under mutation.
