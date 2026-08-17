---
name: mutation-test
description: Suite review — mutation testing as a third code-review axis. A triage subagent runs the mutation tool and returns review findings with recommended dispositions; mutation results are review target sites, never a bar to pass. Use to dispatch or receive the Suite axis during review (/validate, /orchestrate), or to review mutation results after a TDD implementation.
---

The **Suite axis**: third axis of a code review, alongside `/code-review`'s Standards
and Spec. Those two read what the code *says*; only this one asks whether the tests
would notice if it said something else. Its findings are **review target sites, not a
bar to pass** — the deliverable is a table of dispositions, and a table of documented
accepts passes exactly as a table of deletions does.

It is deliberately **not wired into `/code-review` itself**: that skill is third-party
and gets updated from upstream, so anything added to it is lost on the next update. The
axis lives here, in the repo that owns the runner.

## Dispatching the axis

One subagent, dispatched in parallel with the other two review axes — **first**, because
it runs the mutation tool itself and costs tens of minutes (C# ~17, TS ~4) where they
cost a couple. It is fine that it reports last.

Two dispatch rules, both learned from the executor still committing to the branch
while this axis ran:

- **Resolve the fixed point to an immutable SHA before dispatch** (`git rev-parse`),
  never a symbolic ref or branch name. A run against a moving HEAD counted 0 changed
  files and filtered every mutant, reporting an empty audit as a clean one.
- **The axis never shares a worktree with a live executor.** Give it its own
  throwaway worktree pinned at that SHA — `git worktree add --detach <path> <sha>` —
  and remove it after the report. Pinning is then free and a destructive reset is
  structurally impossible; one axis briefed "change no files" ran `git reset --hard`
  on the shared worktree to pin itself and discarded another agent's commit.

Both of those failed the same way — an empty audit read as a clean one — so the
wrappers now refuse it rather than trusting the reader: they resolve the diff with git
in the worktree they're run from, and `parse-report.py` exits 2 when no mutant was
tested (#362, `stryker/stryker.md` §Guardrails). **The axis reports how many mutants
were tested, not just its exit code** — that number is what makes "clean" mean
anything, and its absence is what let a zero-mutant run pass for a pass.

Brief:

> You are the Suite axis of this code review. Work only in `<detached worktree
> path>`, pinned at `<sha>` — never in any other checkout. Read
> `.claude/skills/mutation-test/TRIAGE.md` and follow it end to end: run the mutation
> tool scoped to `<sha>`, triage every finding to exactly one disposition, and report
> the findings table in TRIAGE.md's format.
> **Propose only — change no files, and no ref or history operations: `git reset`,
> `git checkout`, `git rebase`, `git branch -f` are forbidden, not just file edits.**
> Report the table, and above it the count of mutants actually tested — nothing else.

Pass the review's own fixed point as that SHA, so the mutants and the diff under
review are the same set of files. Report the returned table as a third section beside
the other two axes; don't rerank it against them.

Standalone (outside an orchestrated review): follow `TRIAGE.md` yourself, then handle
the table exactly as below.

## Receiving the findings

The table's rows are review findings, handled with the same triage as the other two
axes' (`/validate` step 2: fix now / defer / escalate / reject). Rules that are
specific to this axis:

- **Nothing is edited before the table is approved.** The grouping by disposition shows
  the real shape of the work — fifty findings in one file are usually one or two pieces
  of work, not fifty.
- **A row closes when its disposition is applied or rejected, gated by the unit suite
  going green.** There is no mutation re-run inside the ticket: the next per-diff run
  re-audits whatever changes again. Rows accepted as invariant or equivalent are closed
  by their recorded reasoning and stay in the report by design.
- **A test enters the suite only through a requirement and a full red-green cycle**
  (`/tdd`). Route C rows are proposals for exactly that — they need their requirement
  confirmed, and are surfaced to the developer rather than applied. Seam refactors
  likewise.
- Apply-time traps, learned the hard way: *"this branch is unreachable"* licenses
  **removing** it, not replacing it with something else — one slice deleted a branch on
  the correct premise and remapped values in the same edit; every gate stayed green and
  a user-visible behavior broke silently. Each code-changing row carries its
  differential (old output, new output, distinguishing input) for exactly this check.
  And the safety net for a change is a **case**, not a file: a test that passes both
  before and after proves nothing about it.

Runner mechanics, cost models, and memory guardrails: `stryker/stryker.md` (C#),
`stryker/stryker-js.md` (TypeScript). `TRIAGE.md` routes the subagent there itself.
