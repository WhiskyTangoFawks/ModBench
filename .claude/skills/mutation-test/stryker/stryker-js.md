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
exit-code contract as the .NET side's `run.sh` (`stryker.md`'s table). Raw Stryker
output goes to a log file and never reaches agent context; that matters here because a
bare `npx stryker run` prints the mutation score table, and a score in context becomes
a target (`TRIAGE.md` §Why dispositions).

Config is `modbench/stryker.config.json`. Reports land in `modbench/reports/mutation/`
(gitignored).

**StrykerJS has no `--since`**, so `run-js.sh` computes it: changed + untracked files
under the mutated roots vs the target from `git diff`, filtered through the config's `!`
exclusions, passed to `--mutate`. Naming a file with `--file` skips the exclusions —
naming it *is* the request to mutate it. Those roots are listed twice — the `mutate`
array and the script's `git diff` pathspec — and must stay in step; a root in one but
not the other mutates on `--all` and silently never on a diff.

**The runner invokes `node_modules/.bin/stryker`, never `npx stryker`**, and runs
`npm ci` first when `node_modules` is absent. `npx` falls back to the registry when
nothing local matches, and the registry's `stryker` is an unrelated abandoned package.
Detached review worktrees are the case that bites: they never carry `node_modules`.

The .NET runner follows the same design, computing its own diff rather than delegating
to Stryker.NET's `since` — which reads the wrong checkout from a linked worktree
(`stryker.md` §Guardrails). Neither wrapper delegates diff resolution to the tool.

## Scope, and why it stops where it does

Mutation runs against `src/modmanager/` and `src/medit/`:

- **`src/modmanager/mo2/*.ts` and friends are the payload** — pure transforms by invariant
  (`modbench/CLAUDE.md`: byte-faithful surgical edits, never model→re-serialization). Parsers,
  an index, a conflict resolver: real branching, real boundaries. The bug history is the
  argument — BOM-handling bugs (a modlist BOM silently dropping the first mod) are exactly
  the boundary class that survives a green suite and dies to a mutant.
- **`src/medit/` is in scope.** mEdit is a thin extension-side view whose backend-crossing
  logic lives in `MEditService/` and is mutated there — but `medit/` carries genuine
  extension-side logic of its own (decoration state, save classification, row URIs, message
  routing), and most of its modules have unit tests only mutation can audit. Coverage here
  is also how drift from the thin-view rule gets noticed: a `medit/` module rich enough to
  produce interesting mutants is a module worth asking about.
- **`*Provider.ts` / `*Panel.ts` are excluded under `modmanager/` only** — VS Code tree and
  webview plumbing with no unit tests. Their `medit/` counterparts stay in scope because
  they *do* have tests, mocking `vscode` per file with `vi.mock('vscode')`.
- **Test code is excluded on both sides** (`**/*.test.ts`, `*/test/**`) — fixture builders.
  Mutating a fixture tells you nothing about the code under test; an early run wasted 24
  findings proving it.
- **`src/medit/generated/**` is excluded** — `api.ts` is regenerated from the OpenAPI spec
  (`/regenerate-api`). A surviving mutant there is a finding against the generator's input,
  which no test in this repo should be pinning.

## Cost model

Measured 2026-08-16 at the capped 4-worker concurrency. Nothing like the .NET side —
this is cheap enough to run per-ticket:

| Scope | Mutants | Wall clock |
| ----- | ------- | ---------- |
| One file (`fileConflictIndex.ts`) | 71 | ~1m30s |
| All of `src/modmanager/` (30 files) | 1799 | **3m40s** |

⚠️ **Measured before `src/medit/` entered scope.** `--all` now mutates roughly
twice the corpus and has not been re-timed; the per-file and per-diff figures are
unaffected. Re-measure on the next `--all` run and replace this note with the number.

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
> `maxTestRunnerReuse: 40`) — do not raise either value.** At the default (cpus−1 = 11
> workers here) each vitest worker grows toward ~3 GB over a full run, and the kernel
> OOM killer targets VS Code before it targets the runaway workers.
> `maxTestRunnerReuse` restarts each worker after 40 runs, bounding the growth. One
> mutation run at a time, machine-wide: `run-js.sh` refuses to start beside a live run
> of either runtime.

## Baseline

The first full run (2026-08-13) produced **330 actionable findings** — 272 survived, 58
uncovered — concentrated in `deployer.ts` (66), `mo2/modlistText.ts` (44) and
`install/detectRoot.ts` (43).

That is a **backlog, not a review.** A list that size is exactly what tempts an agent into
one-micro-test-per-survivor. Work it in file-sized slices, each through `TRIAGE.md` with its
own disposition table, or it will do more harm than good. The per-diff axis is the intended
day-to-day use; this number is only the starting point it is measured against.
