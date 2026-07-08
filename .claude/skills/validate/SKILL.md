---
name: validate
description: Post-implementation review-and-ship workflow. Run at the end of any coding task.
---

# Validate

Run after any implementation task.

## Step 1 — Gates

```bash
git diff --name-only HEAD && git diff --name-only --cached
```

Classify changed files → run matching gate (never review non-compiling code):

| Changed | Command |
|---|---|
| `MEditService/**/*.cs` | `bash .claude/skills/validate/run-gates.sh --backend` |
| `modbench/**` | `… --frontend` |
| both | `… --backend --frontend` |
| config/docs only | skip |

Fix all failures, rerun. Core CS (`MEditService/MEditService.Core/**/*.cs`) = mutation-eligible → Step 4.

## Step 2 — Review

1. Run `/code-review` **report-only** (no `--fix`; `high`/`ultra` for large/risky).
2. Triage every finding (first match):

| Outcome | When → Action |
|---|---|
| **Fix now** | in scope, or cheap + adjacent → apply |
| **Defer** | valid, out of scope/large → `gh issue create` (`tech debt` + `ready-for-agent`\|`needs-triage`); body = finding + analysis + rec; link it |
| **Escalate** | ambiguous / wide blast radius → ask dev: fix / ignore / issue |
| **Reject** | not real → note why |

3. Rerun Step 1 gates if any fix changed logic.

Complexity / quality notes are not a validate step: the `code-quality` Stop hook surfaces them continuously during the work, scoped to changed files, for in-loop triage. Validate owns correctness, gates, and mutation — not the complexity re-check.

## Step 3 — Commit

- On `main` → `git checkout -b <slug>`.
- Commit autonomously — reference issue/task

Must precede mutation (Stryker `--since` diffs `HEAD`..`main`).

## Step 4 — Mutation (Core CS logic only)

If Step 1 touched `MEditService.Core` logic: run `/mutation-test`.

## Step 5 — Merge & complete

- `git checkout main && git merge --no-ff <branch> && git push`.
- close issue