# StrykerJS — running mutation tests on the TypeScript side

Companion to `stryker.md` (which covers Stryker.**NET** and `MEditService.Core`). The review
philosophy and triage live in `SKILL.md`; this file is only *how to run and read the tool* for
`modbench`. The two runtimes share nothing but the report schema — do not carry mechanics
across.

## Running

```bash
cd modbench && npm run test:mutation                      # configured scope
cd modbench && npx stryker run --mutate "src/modmanager/deployer.ts"   # one file
cd modbench && npx stryker run --mutate "src/a.ts,src/b.ts"            # the diff's files
```

Config is `modbench/stryker.config.json`. Reports land in `modbench/reports/mutation/`
(gitignored).

**There is no `--since`.** StrykerJS has `--incremental` (reuse prior results) but no
diff-scoping flag, so the review-axis equivalent is to pass the diff's changed files to
`--mutate` explicitly. That is the whole difference from the .NET side's `since` handling.

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

Measured 2026-08-13. Nothing like the .NET side — this is cheap enough to run per-ticket:

| Scope | Mutants | Wall clock |
| ----- | ------- | ---------- |
| One file (`fileConflictIndex.ts`) | 71 | ~1m30s |
| All of `src/modmanager/` (29 files) | 1869 | **3m11s** |

The initial test run is 173 tests in 3 seconds, and `coverageAnalysis: perTest` means each
mutant runs only its covering tests. There is no build step to pay for, which is where the
.NET side's ~8 minutes goes.

## What does *not* apply here

- **No `TERM=linux` bug.** That one is Stryker.NET-specific; StrykerJS prints normally under
  the ambient non-interactive `TERM`. Verified, not assumed.
- **No pty, no wrapper script.** `npx stryker run` behaves, so there is nothing for a
  `run.sh` to fix. Don't add one for symmetry.
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

## Baseline

The first full run scored **82.34%** — 1529 killed, 272 survived, 58 uncovered, 10 timeout;
**330 actionable findings**, concentrated in `deployer.ts` (66), `mo2/modlistText.ts` (44) and
`install/detectRoot.ts` (43).

That is a **backlog, not a review.** A list that size is exactly what tempts an agent into
one-micro-test-per-survivor, which §4 of `SKILL.md` forbids. Work it in file-sized slices with
a disposition table each, or it will do more harm than good. The per-diff axis is the intended
day-to-day use; this number is only the starting point it is measured against.
