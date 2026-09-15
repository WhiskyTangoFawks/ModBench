# Stryker.NET — running mutation tests here

Tool-specific mechanics for the `mutation-test` review skill. Stryker.NET runs scoped to
**one box at a time** — one production project (`MEditService.<Box>`) mutated against
exactly that box's own test project (`MEditService.<Box>.Tests`); commands run from
`MEditService/`. `MEditService.CrossBox.Tests` is never a run's test project — it holds
no production code of its own to mutate, and every per-box run names only that box's own
test project, so it is excluded by construction, not by an exclusion list. The review
philosophy and triage live in `TRIAGE.md` — this file is only *how to run and read the
tool*.

## Running the report

```bash
cd MEditService && bash ../.claude/skills/mutation-test/stryker/run.sh --box <Box>
```

`<Box>` is one of `Codec Commands Http Index LoadOrder PluginAdapter Ports Queries
SourceRepo Watcher` — the ten production projects. `run.sh` prints its scope, then the
report path, then the parsed survivors. Raw Stryker output goes to a log file and never
reaches agent context.

| Exit | Means |
| ---- | ----- |
| 0 | every mutant killed |
| 1 | survivors await disposition — **not** a failure |
| 2 | tool error (bad ref, concurrent run, no report produced, unknown/missing `--box`, **nothing audited**) |
| 3 | nothing in scope: the diff held no mutable C# in that box. A clean skip. |

Scopes:

```bash
# default: <Box> C# changed vs the merge-base with since.target (main), committed or not
bash ../.claude/skills/mutation-test/stryker/run.sh --box Ports

# explicit target — the post-merge batch form, e.g. the commit before a landed epic
bash ../.claude/skills/mutation-test/stryker/run.sh --box Ports --since <ref-or-sha>

# narrow the report to survivors whose lines intersect the git diff
bash ../.claude/skills/mutation-test/stryker/run.sh --box Ports --diff-only

# the whole box's corpus — see the cost model below
bash ../.claude/skills/mutation-test/stryker/run.sh --box Ports --all

# one file, run whether or not that file has a diff
bash ../.claude/skills/mutation-test/stryker/run.sh --box Queries --file ConflictClassifier.cs
```

**`run.sh` computes the diff itself and hands Stryker an explicit mutate list; Stryker's
own `since` is never enabled** (see the worktree guardrail below). `since.target` in
`stryker-config.template.json` survives only as the *default diff target* both wrappers
read; `since.enabled` is `false` so a bare `dotnet-stryker` can't reach the broken path
either.

`stryker-config.template.json` is a template, not a runnable config: its `test-projects`
and `mutate` entries are placeholders `run.sh` overwrites for the named box before every
run, writing the filled-in config to `.stryker-run.json` (gitignored, removed on exit).
Nothing reads `stryker-config.template.json` directly except `run.sh` and
`parse-report.py` (for `since.target`) — there is deliberately no per-box config file
checked in; ten near-identical files would drift the moment one `ignore-methods` or
threshold changed and the other nine didn't.

**Scope is file-level, not diff-level.** Touching one line makes *every* testable line in
that file eligible for mutation — mutate globs name files, not lines. This is intentional
(a full entropy audit of files you touch, not a diff-coverage gate), but means survivor
counts on a large touched file can look alarming for a small mechanical change. `--diff-only`
is the narrower "did my actual diff introduce anything new" view.

Re-read an existing report without re-running:

```bash
cd MEditService && python3 ../.claude/skills/mutation-test/stryker/parse-report.py
cd MEditService && python3 ../.claude/skills/mutation-test/stryker/parse-report.py --diff-only
```

## Cost model

Measured on this repo pre-split, across the whole former `MEditService.Core`. Per-box
figures are smaller in proportion to each box's own size — budget from these ratios, not
from folklore, and re-measure the first time a box's own number matters:

| Phase | Cost |
| ----- | ---- |
| Build + mutate + coverage capture (fixed, every run) | ~8 min cold, ~12s warm build |
| Each mutant actually tested | ~1.8s |
| A since-scoped batch across three landed tickets (314 mutants, whole corpus) | **~17 min total** |
| Verified per-box: `--box Ports --all`, the smallest box | **~24 min total** (5 mutants tested, 20 created) |

A `--all` run is expensive because of mutant *count* — the whole box, at the per-mutant
rate above. Prefer `--since`. The smallest boxes (`Ports`, `LoadOrder`) mutate only a
handful of files, but the fixed cost measured higher per-box than the pre-split figure
above (`--project` narrows *which* project is mutated, not how long its own coverage
baseline takes) — budget nearer 25 min cold for a first per-box run in this environment
until a second box's figure confirms whether that is a box-split tax or this run's own
variance. The larger boxes (`Http`, `Commands`, `Index`) will cost more still.

**Timeouts are a real but secondary tax.** Mutating the async load-order-lifecycle code deadlocks
rather than fails: a broken cancellation check or loop-exit produces no answer at all, and from
outside the process "hung" and "slow" are indistinguishable, so a timeout is the only sound
detector Stryker has. One full pre-split run put 200 mutants in `Timeout` — `IndexProjector.cs`
(99, now in `MEditService.Index`), `RecordQueryService.cs` (61, now in `MEditService.Queries`),
`LoadOrder.cs` (39, now in `MEditService.LoadOrder`), `LoadOrderStatus.cs` (1, now in
`MEditService.Ports`) — which at the default 6-way concurrency cost roughly half that run's
mutation phase, not the hours it looks like.

**Do not "fix" this by lowering the timeout.** A `Timeout` counts as not-survived, so a
too-tight timeout marks would-be *Survivors* as killed — it hides exactly the findings the run
exists to produce. The only sound acceleration would be per-test timeouts
(`[Fact(Timeout = n)]`), which turn a hang into a genuine failure; that is a wide change to
production tests for a tool's benefit, and has not been made.

What *was* done: `RecordQueryService.cs` (box `Queries`) and `LoadOrderStatus.cs` (box
`Ports`) are excluded via `run.sh`'s own `BOX_EXCLUSIONS_Queries` / `BOX_EXCLUSIONS_Ports`
table, because they yielded **zero information** — 61 and 1 tested mutants respectively,
all of them `Timeout`, nothing killed and nothing survived. `LoadOrder.cs` (box
`LoadOrder`) and `IndexProjector.cs` (box `Index`) are kept: they time out heavily but
still produce real findings (25 killed, 1 survived, 6 uncovered). `run.sh` applies a
box's exclusion even when it builds an explicit mutate list from the working tree, so
having that file dirty does not quietly put it back in scope — but naming it via `--file`
does, since that is an explicit request.

## Guardrails

> ⚠️ **`TERM=linux` makes Stryker emit nothing at all** — not one byte, not even for
> `--help`, and it still exits 0. It is the ambient `TERM` in a non-interactive shell, so
> every unattended run was silently blank. Every other value works, including `dumb` and
> unset. `run.sh` sets `TERM=xterm` for exactly this reason; don't remove it, and don't
> reach for a pty to "give Stryker a terminal" — it writes to stdout perfectly well.

> ⚠️ **Run `run.sh` detached and poll it in the foreground.** A since-scoped run outlasts the
> 10-minute foreground command cap, so a foreground call gets killed two-thirds through and
> looks exactly like a silent failure. From `MEditService/`:
> `bash ../.claude/skills/validate/detached.sh start stryker bash ../.claude/skills/mutation-test/stryker/run.sh --box <Box> --since <ref>`,
> then `bash ../.claude/skills/validate/detached.sh wait stryker` until it prints the verdict.
> Exit 3 means call it again, and its "still running" line carries the log's last line.
> `run.sh` spawns no terminal window. Never `pkill dotnet` — that kills VS Code's C# servers;
> match `dotnet-stryker` specifically.

> ⚠️ **Stryker's `since` resolves against the wrong checkout inside a linked worktree.**
> `GitInfoProvider.RepositoryPath` is `Repository.Discover(projectPath).Split(".git")[0]`;
> in a linked worktree `Discover` returns `<main>/.git/worktrees/<name>`, so the split
> yields **`<main>/`** and Stryker would diff the *main checkout's* working directory
> instead of the one it's actually running in. There is no config or CLI knob for the
> repository path, and the split would mangle any path containing `.git` regardless.
> `run.sh` computes the changed-file set with git itself and strips `since` from the
> generated config unconditionally, exactly as `run-js.sh` always has. Don't hand diff
> resolution back to Stryker.

> ⚠️ **A bad diff target costs ~8 minutes of silence if it reaches Stryker unchecked.**
> Stryker validates its git ref only *after* building, mutating and capturing coverage, then
> exits leaving an output directory with no report in it. Short SHAs do not resolve (`2fc21c8`
> fails, its full SHA works). `run.sh` resolves and verifies the ref up front, and refuses an
> empty scope with exit 3, so neither costs more than a second.

> ⚠️ **Zero audited mutants is exit 2, never "No issues found."** `parse-report.py`
> refuses to report on a run in which nothing was `Killed`/`Survived`/`Timeout`/
> `NoCoverage`, printing the status and ignore-reason breakdown instead. A filtered-out
> run and a clean run are otherwise indistinguishable from the outside, and the failure
> reads in the reassuring direction — that's exactly what makes it easy to miss.

> ⚠️ **One run at a time.** Two concurrent runs contend for the same build output and one
> dies with no report — which is easy to cause, because a silent run looks hung. `run.sh`
> refuses to start if another is live, regardless of which box either names.

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
**only after explicit developer approval**, always with a reason. Since there is no
per-box config file checked in, a project-wide suppression goes in
`stryker-config.template.json`'s `ignore-mutations`/`ignore-methods` (applies to every
box's run); a box-specific one is a new entry in `run.sh`'s `BOX_EXCLUSIONS_<Box>` table,
next to the two it already carries.

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
in review. Only logging goes untested by default — via `stryker-config.template.json`, never
comment annotations.

## Request-a-fixture disposition (Mutagen seams)

`TRIAGE.md`'s "Request a fixture" disposition applies here when a guard handles **malformed/edge-case
plugin data** on a Mutagen-facing seam you cannot synthesize (the error requires bad binary
data). The code is likely genuinely needed — do **not** delete or blind-accept. Ask the
developer for a plugin exhibiting the condition, then write a real behavioral test against it.
Log entry `request-fixture:<condition>`; the survivor is paused until the fixture arrives.

## testing-the-framework here

For the `testing-the-framework` test smell (`TRIAGE.md` §Test-smell taxonomy): the flavour in
this repo is a test that exercises **Mutagen / DuckDB / library** behavior rather than our own
logic. The backend flavour of `mechanism-not-outcome` is asserting on internal repository
calls or intermediate DTO shape rather than the queried/saved result.

## Known issues

- **~1000 `CompileError` mutants per run are expected** across the boxes that carry them,
  and they trace to only ~18 methods total. Stryker's "Safe Mode" discards every mutation
  in a method once one fails to compile, and two errors account for all of it: `CS0165`
  (unassigned local — block removal against definite assignment) and `CS0411` (LINQ
  `Select` overload inference). Concentrated in `RenumberRecordHandler.cs` (box
  `Commands`) and `DuckDbRecordIndex.cs` (box `Index`). Counted and ignored
  automatically — not a signal.
- The full-install smoke test (`RealData/RealInstallSmokeTests.cs`, in
  `MEditService.Http.Tests`) is gated behind `MEDIT_SMOKE=1` so it never runs under
  mutation.
- `MEditService.CrossBox.Tests` holds tests whose subject spans two or more boxes — the
  debt a follow-up rewrites away one fixture at a time, at each box's own interface. It
  is excluded from every per-box run by construction: no per-box run ever names it as a
  test project. A mutant in a box whose only real-world exerciser sits in that project
  will show `NoCoverage` under `--box`. That is a true finding about the box split, not a
  tool bug — the fix is the follow-up rewrite, not a suppression here.
