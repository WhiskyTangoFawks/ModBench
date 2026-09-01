---
name: validate
description: Repo gate runner — classify changed files, run the matching build/test gates. Use at the end of any coding task, and whenever a skill (e.g. /implement) says to run the tests or the full test suite.
---

# Validate

The repo's gates: classify what changed, run the matching gates, fix failures, rerun.
(`/validate gates` is the same thing — legacy wording that `/orchestrate` briefs still use.)

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

`--api-drift` boots a fresh backend and fails if `modbench/src/medit/generated/api.ts`
has drifted from the live OpenAPI spec — any endpoint/DTO annotation change can
silently invalidate it, so it rides along with `--backend`, not `--frontend`.

Run gate commands with an explicit `timeout: 600000` — the Bash tool's 120 s default
silently backgrounds a full `dotnet test` run, which reads as a hang or a skipped gate.

Fix all failures, rerun.

## Finding dispositions

Review itself belongs to the calling workflow (`/implement` closes with `/code-review`;
`/orchestrate` step 5 runs its own). In-loop, the maintainer rules on findings live. An
orchestrated run dispositions by this table (first match) — and never files an issue: the
tracker holds no standing bug/tech-debt backlog (`docs/agents/issue-tracker.md`):

| Outcome | When → Action |
|---|---|
| **Fix now** | correct fix is unambiguous and stays within files this branch already touches (or their immediate surface) → apply, even if the issue never asked for it |
| **Escalate** | real, but value uncertain or blast radius wide → a second opinion is a question, never a ticket: ask dev (interactive) or the advisor (orchestrated); verdict is fix / reject / report |
| **Report** | real, of settled value, but needs its own design or plan, or touches surface outside this branch → state it in the session summary (finding + analysis + recommendation); the maintainer decides whether it enters the grill → `/to-spec` pipeline |
| **Reject** | not real → note why |

Rerun the gates if any fix changed logic.

Mutation testing (`/mutation-test`, the Suite axis) is not a validate step — a full
Stryker run takes hours, so it is dispatched only when explicitly asked for.

Complexity / quality notes are not a validate step: the `code-quality` Stop hook surfaces
them continuously during the work, scoped to changed files, for in-loop triage. Validate
owns correctness and gates — nothing else.
