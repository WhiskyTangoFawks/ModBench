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
git diff --name-only HEAD && git diff --name-only --cached
```

Classify changed files → run matching gate (never review non-compiling code):

| Changed | Command |
|---|---|
| `MEditService/**/*.cs` | `bash .claude/skills/validate/run-gates.sh --backend` |
| `modbench/**` | `… --frontend` |
| both | `… --backend --frontend` |
| config/docs only | skip |

Run gate commands with an explicit `timeout: 600000` — the Bash tool's 120 s default
silently backgrounds a full `dotnet test` run, which reads as a hang or a skipped gate.

Fix all failures, rerun.

## Step 2 — Review

1. Mutation-eligible diff (`MEditService/MEditService.Core/**/*.cs` or
   `modbench/src/modmanager/**/*.ts`, excluding `test/**`, `*Provider.ts`, `*Panel.ts`)
   → dispatch the **Suite axis first** (`/mutation-test` carries the brief): a subagent
   runs the tool and returns a findings table, reported as a third section. It is
   review, not a gate — there is no score to reach.
2. Run `/code-review` **report-only** (no `--fix`; `high`/`ultra` for large/risky).
3. Triage every finding — all axes' — (first match):

| Outcome | When → Action |
|---|---|
| **Fix now** | in scope, or cheap + adjacent → apply |
| **Defer** | valid, out of scope/large → `gh issue create` (`tech debt` + `ready-for-agent`\|`needs-triage`); body = finding + analysis + rec; link it |
| **Escalate** | ambiguous / wide blast radius → ask dev: fix / ignore / issue |
| **Reject** | not real → note why |

4. Rerun Step 1 gates if any fix changed logic.

Complexity / quality notes are not a validate step: the `code-quality` Stop hook surfaces them continuously during the work, scoped to changed files, for in-loop triage. Validate owns correctness, gates, and mutation — not the complexity re-check.
