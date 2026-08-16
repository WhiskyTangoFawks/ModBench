# Stryker.NET — running mutation tests here

Tool-specific mechanics for the `mutation-test` review skill. Stryker.NET mutates
`MEditService.Core`; commands run from `MEditService/`. The review philosophy and triage
live in `TRIAGE.md` — this file is only *how to run and read the tool*.

## Running the report

```bash
cd MEditService && bash ../.claude/skills/mutation-test/stryker/run.sh
```

`run.sh` prints its scope, then the report path, then the parsed survivors. Raw Stryker
output goes to a log file and never reaches agent context.

| Exit | Means |
| ---- | ----- |
| 0 | every mutant killed |
| 1 | survivors await disposition — **not** a failure |
| 2 | tool error (bad ref, concurrent run, no report produced) |
| 3 | nothing in scope: the diff held no mutable C#. A clean skip. |

Scopes:

```bash
# default: C# changed vs since.target (main), falling back to the working tree
bash ../.claude/skills/mutation-test/stryker/run.sh

# explicit target — the post-merge batch form, e.g. the commit before a landed epic
bash ../.claude/skills/mutation-test/stryker/run.sh --since <ref-or-sha>

# narrow the report to survivors whose lines intersect the git diff
bash ../.claude/skills/mutation-test/stryker/run.sh --diff-only

# full MEditService.Core corpus, since disabled — see the cost model below
bash ../.claude/skills/mutation-test/stryker/run.sh --all

# one file, since disabled so it runs whether or not that file has a diff
bash ../.claude/skills/mutation-test/stryker/run.sh --file ConflictClassifier.cs
```

**Scope is file-level, not diff-level.** Touching one line makes *every* testable line in
that file eligible for mutation — Stryker has no line-level diff filter. This is intentional
(a full entropy audit of files you touch, not a diff-coverage gate), but means survivor
counts on a large touched file can look alarming for a small mechanical change. `--diff-only`
is the narrower "did my actual diff introduce anything new" view.

Re-read an existing report without re-running:

```bash
cd MEditService && python3 ../.claude/skills/mutation-test/stryker/parse-report.py
cd MEditService && python3 ../.claude/skills/mutation-test/stryker/parse-report.py --diff-only
```

## Cost model

Measured on this repo, 2026-08-13. Budget from these, not from folklore:

| Phase | Cost |
| ----- | ---- |
| Build + mutate + coverage capture (fixed, every run) | ~8 min cold, ~12s warm build |
| Each mutant actually tested | ~1.8s |
| A since-scoped batch across three landed tickets (314 mutants) | **~17 min total** |

An `--all` run is expensive because of mutant *count* — the whole corpus, at the per-mutant
rate above. Prefer `--since`.

**Timeouts are a real but secondary tax.** Mutating the async session-lifecycle code deadlocks
rather than fails: a broken cancellation check or loop-exit produces no answer at all, and from
outside the process "hung" and "slow" are indistinguishable, so a timeout is the only sound
detector Stryker has. One full run put 200 mutants in `Timeout` — `SessionManager.cs` (99),
`RecordQueryService.cs` (61), `GameSession.cs` (39), `SessionStatus.cs` (1) — which at the
default 6-way concurrency cost roughly half that run's mutation phase, not the hours it looks
like.

**Do not "fix" this by lowering the timeout.** A `Timeout` counts as not-survived, so a
too-tight timeout marks would-be *Survivors* as killed — it hides exactly the findings the run
exists to produce. The only sound acceleration would be per-test timeouts
(`[Fact(Timeout = n)]`), which turn a hang into a genuine failure; that is a wide change to
production tests for a tool's benefit, and has not been made.

What *was* done: `RecordQueryService.cs` and `SessionStatus.cs` are excluded in
`stryker-config.json`, because they yielded **zero information** — 61 and 1 tested mutants
respectively, all of them `Timeout`, nothing killed and nothing survived. `GameSession.cs` and
`SessionManager.cs` are kept: they time out heavily but still produce real findings (25 killed,
1 survived, 6 uncovered). `run.sh` preserves these `!` exclusions even when it builds an
explicit mutate list from the working tree, so having one of those files dirty does not quietly
put it back in scope — but naming one via `--file` does, since that is an explicit request.

## Guardrails

> ⚠️ **`TERM=linux` makes Stryker emit nothing at all** — not one byte, not even for
> `--help`, and it still exits 0. It is the ambient `TERM` in a non-interactive shell, so
> every unattended run was silently blank. Every other value works, including `dumb` and
> unset. `run.sh` sets `TERM=xterm` for exactly this reason; don't remove it, and don't
> reach for a pty to "give Stryker a terminal" — it writes to stdout perfectly well.

> ⚠️ **Run `run.sh` as a background task and poll it.** A since-scoped run outlasts the
> 10-minute foreground command cap, so a foreground call gets killed two-thirds through and
> looks exactly like a silent failure. This reverses the old instruction: an earlier `run.sh`
> spawned a developer-visible terminal window, which backgrounding would kill. It no longer
> spawns anything, so backgrounding is now both safe and required. Never `pkill dotnet` —
> that kills VS Code's C# servers; match `dotnet-stryker` specifically.

> ⚠️ **A bad `since` target costs ~8 minutes of silence.** Stryker validates the git ref
> only *after* building, mutating and capturing coverage, then exits leaving an output
> directory with no report in it. Short SHAs do not resolve (`2fc21c8` fails, its full SHA
> works). `run.sh` resolves and verifies the ref up front, and refuses an empty scope with
> exit 3, so neither costs more than a second.

> ⚠️ **One run at a time.** Two concurrent runs contend for the same build output and one
> dies with no report — which is easy to cause, because a silent run looks hung. `run.sh`
> refuses to start if another is live.

> ⚠️ **Never read `mutation-report.json` directly.** Files run 2–7 MB with full source
> embedded. Always go through `run.sh` / `parse-report.py` — only the summary reaches context.

> ⚠️ **Don't put `"progress"` in the reporters.** It draws a ShellProgressBar that throws
> `ArgumentOutOfRangeException` under a width-less pty. `run.sh` uses `dots` instead: plain
> characters, no ANSI repaint, survives redirection, and gives a live heartbeat in the log
> (`.` killed, `S` survived, `T` timeout).

> 🏎️ **Dispositions close via the unit suite, not a mutation re-run** (`SKILL.md`
> §Receiving) — the next per-diff run re-audits whatever changed. `--file` exists to scope
> a *fresh audit* at a named file, and even it pays the ~8 min fixed cost. There is **no**
> `--mutant-ids` option; Stryker.NET's config schema rejects it (confirmed against the
> installed CLI). Don't re-add it.

## Suppression format

The durable, config-level form of `TRIAGE.md`'s **Accept as invariant** disposition —
**only after explicit developer approval**, always with a reason.

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

`TRIAGE.md`'s "Request a fixture" disposition applies here when a guard handles **malformed/edge-case
plugin data** on a Mutagen-facing seam you cannot synthesize (the error requires bad binary
data). The code is likely genuinely needed — do **not** delete or blind-accept. Ask the
developer for a plugin exhibiting the condition, then write a real behavioral test against it.
Ledger entry `request-fixture:<condition>`; the survivor is paused until the fixture arrives.

## testing-the-framework here

For the `testing-the-framework` test smell (`TRIAGE.md` §Test-smell taxonomy): the flavour in
this repo is a test that exercises **Mutagen / DuckDB / library** behavior rather than our own
logic. The backend flavour of `mechanism-not-outcome` is asserting on internal repository
calls or intermediate DTO shape rather than the queried/saved result.

## Known issues

- **~1000 `CompileError` mutants per run are expected**, and they trace to only ~18 methods.
  Stryker's "Safe Mode" discards every mutation in a method once one fails to compile, and
  two errors account for all of it: `CS0165` (unassigned local — block removal against
  definite assignment) and `CS0411` (LINQ `Select` overload inference). Concentrated in
  `Fallout4ConditionCodec.cs`, `VmadCodec.cs`, `EditOrchestrator.cs`, `DuckDbRecordRepository.cs`
  and `ConditionConflictClassifier.cs`. Counted and ignored automatically — not a signal.
- The full-install smoke test (`RealData/RealInstallSmokeTests.cs`) is gated behind
  `MEDIT_SMOKE=1` so it never runs under mutation.
