# StrykerJS — running mutation tests on the TypeScript side

Companion to `stryker.md` (which covers Stryker.**NET** and `MEditService.Core`). The review
philosophy and triage live in `TRIAGE.md`; this file is only *how to run and read the tool* for
`modbench`. The two runtimes share nothing but the report schema — do not carry mechanics
across.

## Running

```bash
cd modbench && bash ../.claude/skills/mutation-test/stryker/run-js.sh              # changed files vs main
cd modbench && bash ../.claude/skills/mutation-test/stryker/run-js.sh --since <ref>
cd modbench && bash ../.claude/skills/mutation-test/stryker/run-js.sh --all        # full corpus + baseline snapshot
cd modbench && bash ../.claude/skills/mutation-test/stryker/run-js.sh --file deployer.ts
```

`run-js.sh` prints its scope, then the report path, then the parsed survivors — same
exit codes as the .NET side's `run.sh` (0 killed, 1 survivors await disposition, 2 tool
error, 3 nothing in scope). Raw Stryker output goes to a log file and never reaches
agent context; that matters here because a bare `npx stryker run` prints the mutation
score table, and a score in context becomes a target (`TRIAGE.md` §Why dispositions).

Config is `modbench/stryker.config.json`. Reports land in `modbench/reports/mutation/`
(gitignored).

**StrykerJS has no `--since`**, so `run-js.sh` computes it: changed + untracked
`src/modmanager` files vs the target from `git diff`, filtered through the config's `!`
exclusions, passed to `--mutate`. Naming a file with `--file` skips the exclusions —
naming it *is* the request to mutate it.

That accident of the JS runner turned out to be the correct design on both sides: the
.NET runner now does the same, because Stryker.NET's own `since` reads the wrong checkout
from a linked worktree (#362, `stryker.md` §Guardrails). Neither wrapper delegates diff
resolution to the tool.

## Scope, and why it stops where it does

Mutation runs against `src/modmanager/` only:

- **`src/modmanager/mo2/*.ts` and friends are the payload** — pure transforms by invariant
  (`modbench/CLAUDE.md`: byte-faithful surgical edits, never model→re-serialization). Parsers,
  an index, a conflict resolver: real branching, real boundaries. The bug history is the
  argument — #17 "modlist BOM drops first mod" and #47 "modlist write BOM" are exactly the
  boundary class that survives a green suite and dies to a mutant.
- **`src/medit/` is excluded** — a thin extension-side view by architectural rule; its logic
  lives in `MEditService/` and is mutated there instead. Mutating a message router mostly
  surfaces glue.
- **`*Provider.ts` / `*Panel.ts` are excluded** — VS Code tree and webview plumbing.
- **`src/modmanager/test/**` is excluded** — fixture builders. Mutating a fixture tells you
  nothing about the code under test; an early run wasted 24 findings proving it.

## Cost model

Measured 2026-08-16 at the capped 4-worker concurrency. Nothing like the .NET side —
this is cheap enough to run per-ticket:

| Scope | Mutants | Wall clock |
| ----- | ------- | ---------- |
| One file (`fileConflictIndex.ts`) | 71 | ~1m30s |
| All of `src/modmanager/` (30 files) | 1799 | **3m40s** |

The cap is nearly free: the old 11-worker default finished the same corpus only ~30s
faster, by thrashing all 15 GiB — it was never CPU-bound. The initial test run is 563
tests in 8 seconds, and `coverageAnalysis: perTest` means each mutant runs only its
covering tests. There is no build step to pay for, which is where the .NET side's ~8
minutes goes.

## What does *not* apply here

- **No `TERM=linux` bug.** That one is Stryker.NET-specific; StrykerJS prints normally under
  the ambient non-interactive `TERM`. Verified, not assumed.
- **No mass `CompileError`.** StrykerJS disables type checks on mutated output, so the .NET
  side's ~1000 rolled-back mutants have no counterpart.

## Reading the report

`parse-report.py` (next to this file) reads the StrykerJS report **unchanged** — both runtimes
emit the standard mutation-testing-report schema:

```bash
cd modbench && python3 ../.claude/skills/mutation-test/stryker/parse-report.py reports/mutation/mutation.json
```

Same guardrail as the .NET side: **never read `mutation.json` directly.** Only the parsed
survivor list reaches context.

> ⚠️ **Every run overwrites `mutation.json`** — the json reporter writes one fixed path,
> so a scoped verification run silently replaces the full-scope report it was measured
> against (a slice once took the 330-finding baseline with it that way). `run-js.sh --all`
> therefore copies each fresh full report to `reports/mutation/baseline.json`, which no
> scoped run touches; `parse-report.py` reads it the same way. Stryker.**NET** has no such
> trap — it writes timestamped `StrykerOutput/<date>/` directories.

> ⚠️ **Concurrency is capped in `stryker.config.json` (`concurrency: 4`,
> `maxTestRunnerReuse: 40`) because the default OOMed the machine.** At the default
> (cpus−1 = 11 workers here) each vitest worker grows toward ~3 GB over a full run, and
> the kernel OOM killer picks VS Code as its preferred victim — it killed VS Code twice
> in the week of 2026-08-14 and took down the whole desktop session on the 16th.
> `maxTestRunnerReuse` restarts each worker after 40 runs, bounding the growth. Raising
> either value is how the crash comes back. One mutation run at a time, machine-wide:
> `run-js.sh` refuses to start beside a live run of either runtime.

## Baseline

The first full run (2026-08-13) produced **330 actionable findings** — 272 survived, 58
uncovered — concentrated in `deployer.ts` (66), `mo2/modlistText.ts` (44) and
`install/detectRoot.ts` (43).

That is a **backlog, not a review.** A list that size is exactly what tempts an agent into
one-micro-test-per-survivor. Work it in file-sized slices, each through `TRIAGE.md` with its
own disposition table, or it will do more harm than good. The per-diff axis is the intended
day-to-day use; this number is only the starting point it is measured against.
