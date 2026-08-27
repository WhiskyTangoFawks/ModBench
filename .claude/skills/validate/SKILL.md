---
name: validate
description: Post-implementation review-and-ship workflow. Run at the end of any coding task.
---

# Validate

Run after any implementation task.

`/validate` runs both steps. `/validate gates` runs Step 1 and stops — for when a
separate reviewer follows (`/orchestrate` step 5). Review is never skipped, only
relocated.

## Step 1 — Gates

```bash
git symbolic-ref -q HEAD && git merge-base --is-ancestor main HEAD && echo current
git diff --name-only HEAD && git diff --name-only --cached
```

The first line must print `current`: HEAD on a branch that contains `main`. A detached HEAD
or a branch behind `main` gates a tree that will not land — stop and say so (merge `main`
into the branch first; a detached HEAD is the user's to resolve).

Classify changed files → run matching gate (never review non-compiling code):

| Changed | Command |
|---|---|
| `MEditService/**/*.cs` | `bash .claude/skills/validate/run-gates.sh --backend --api-drift` |
| `modbench/**` | `… --frontend` |
| both | `… --backend --frontend --api-drift` |
| config/docs only | skip |

`--api-drift` (#245) boots a fresh backend and fails if `modbench/src/medit/generated/api.ts`
has drifted from the live OpenAPI spec — any endpoint/DTO annotation change can
silently invalidate it, so it rides along with `--backend`, not `--frontend`.

Run gate commands with an explicit `timeout: 600000` — the Bash tool's 120 s default
silently backgrounds a full `dotnet test` run, which reads as a hang or a skipped gate.

Fix all failures, rerun.

## Step 2 — Review

1. Run `/code-review` **report-only** (no `--fix`; `high`/`ultra` for large/risky).
2. Triage every finding — all axes' — (first match). A filed ticket re-buys the
   whole pipeline — triage, queue, a fresh executor re-acquiring the context the
   finder already has, review, land — so weigh the fix against that price, not
   against the originating issue's scope:

| Outcome | When → Action |
|---|---|
| **Fix now** | correct fix is unambiguous and stays within files this branch already touches (or their immediate surface) → apply, even if the issue never asked for it — a fix smaller than its ticket ships now |
| **Escalate** | real, but value uncertain or blast radius wide → a second opinion is a question, never a ticket: ask dev (interactive) or the advisor (orchestrated); verdict is fix / reject / defer |
| **Defer** | genuinely a work item — needs its own design or plan, or touches surface outside this branch → `gh issue create` (`tech debt` + `ready-for-agent`\|`needs-triage`); body = finding + analysis + rec; link it |
| **Reject** | not real → note why |

3. Rerun Step 1 gates if any fix changed logic.

Mutation testing (`/mutation-test`, the Suite axis) is not a validate step — a full
Stryker run takes hours, so it is dispatched only when explicitly asked for
(e.g. `/orchestrate`, or the user invoking `/mutation-test`).

Complexity / quality notes are not a validate step: the `code-quality` Stop hook surfaces them continuously during the work, scoped to changed files, for in-loop triage. Validate owns correctness and gates — not mutation or the complexity re-check.
