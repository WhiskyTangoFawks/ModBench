---
name: git-conventions
description: This repo's git workflow — every stream of work gets its own worktree, the main checkout is merge-only, always. Use before starting work, creating a branch or worktree, before committing, before merging to main, and when auditing or cleaning up worktrees.
---

# Git conventions

**The main checkout is merge-only, unconditionally — not just when other work happens to be
live.** Solo or concurrent, the rule doesn't change: the first stream to start doesn't get to
claim the main checkout as its workspace just because nothing else is running yet. If it does,
the next stream to start has nowhere safe to land. Always work in a worktree.

## Starting work

1. `git worktree list` and `ListAgents` — see what's already live before adding to it.
2. For every live worktree, `git -C <worktree> diff --name-only main` and compare against the
   files your own work expects to touch. Overlap on a shared file: wait, negotiate order, or pick
   a different slice. No overlap: proceed.
3. `git worktree add ../<repo>-fix-<n>-<slug> fix-<n>-<slug>` — a sibling directory, never the
   main checkout. `.claude/worktrees/` belongs to the `Agent` tool's own auto-managed isolation;
   don't hand-create worktrees there.
4. Claim tracked-ticket work immediately: `gh issue edit <n> --add-assignee @me` or a claiming
   comment.

## While working

A worktree isolates the tree, not the runtime. Never run a live backend against the same MO2
instance path from two places at once. A long-running process on a fixed port takes a flock'd
lockfile.
While building or running tests, be aware of memory usage. The current system can handle 2
 builds simultaneously, but not 3.

## Merging

1. /validate is a STRICT gate for merging to main. No code changes can be merged to main without the
the tests passing, and code-review.
2. Merge only from the main checkout, one merge at a time: `git -C <main-checkout-path> merge
   --no-ff <branch>`. Confirm `git status` is clean and no `.git/MERGE_HEAD` exists first.
3. `git fetch && git merge --ff-only origin/main` before pushing.

## Cleanup

1. On merge: `git worktree remove <path>`, `git branch -d <branch>`, immediately.
2. Before removing anything, verify it's actually done — a branch tip matching `main` is not
   enough by itself. Check both: `git log --oneline -1 <branch>` against `main`, and `git -C
   <path> status --short`. Tip matches and the tree is clean: safe to remove. Tip matches but the
   tree is dirty: uncommitted live work, leave it.
3. Separately sweep `.claude/worktrees/` for directories `git worktree list` doesn't recognize —
   confirm with `git worktree prune -n -v`, inspect contents, then remove.
