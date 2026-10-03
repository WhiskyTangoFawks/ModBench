---
name: validate
description: The bar for done. Run before reporting work done, committing for merge, or when a skill says to run the tests or the full suite.
---

# Validate

`main` is the ground every stream of work builds on. Each worktree is cut from it, and each agent reads it as true. A defect that lands there spreads into work that never touched it, and nothing marks it as wrong. So work earns its merge with evidence, never with its author's belief.

The gates are the first evidence: nothing the work can break is broken. A gate run counts only on the tree that will land, and only as a run you watched. Verified means observed. Review is the evidence the gates cannot give. An author reads its own code with the intent it wrote it with, and sees the intent where the code says something else. A separate agent sees only the code.

The work is done when both kinds of evidence exist. Validate runs before the merge because the author still holds the context to fix what the evidence finds. That context is gone once the work merges. *Root cause* governs every fix.

## 1. Gates

Merge current `main` into the branch first. The gates then test the tree that will land. A detached HEAD is the user's to resolve.

Run `bash .claude/skills/validate/run-gates.sh --detach`. Then run `run-gates.sh --wait` in the foreground until it prints a verdict. Exit 3 means wait again. Gates queue on machine-wide slots, so one run can outlast one foreground call. The runner reads the diff since `main`, and names each gate it runs and why.

A red gate is yours to fix. A failure already on `main` is a defect that already landed. It is yours to fix for the same reason. A gate is code, and changing it is tactical. A change serves the gate's purpose: the gate still catches every defect it exists to catch.

**Criterion:** the last run, on the tree you will commit, printed `All mechanical gates passed`.

## 2. Review

The work merges only after a separate agent reviews it. `/code-review` counts, because it reviews in fresh subagents. If the work has no review and your brief sets none ahead of the merge, run `/code-review main` now.

Sort each finding under root CLAUDE.md's chain of authority. Note why a finding is not real. A fix that changes logic sends you back to step 1.

**Criterion:** a separate agent's review covers the work, or your brief sets one ahead of the merge. Every finding is sorted, and the gates are green on the final tree.

## Report

Quote the verdict line. Name the gates that ran and why. List each finding and how you sorted it.
