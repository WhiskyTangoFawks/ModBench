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
| config/docs only | `… ` with no flag — Gate 1 alone |

`bash .claude/skills/validate/run-gates.sh` with no flags runs Gate 1 alone in seconds and exits 1 on failure; an orchestrator runs it on a branch before merging, because the editor-time hook does not fire on script-patched files. Gate 1 (comment discipline) runs on every invocation (excluded paths in `run-gates.sh`'s
`EXCLUDE_RE`): Vale over comments in `.cs`/`.ts`/`.tsx`/`.py`/`.mjs` and over markdown text
(`.vale.ini`); Vale over those plus `.sh`/`.yml`/`.json`/`.csproj`/`.props` as raw text, which
reaches string literals but carries only the History and Ticket rules (`.vale-raw.ini`);
`comment-shape.py` for the doc-comment shape checks on `.cs`/`.ts`/`.tsx`; and the discipline's own
tests (`.claude/hooks/test_*.py`). The pinned binary comes from `install-vale.sh`. The gate
runner's own tests (`.claude/skills/validate/test_*.py`) run beside it on every invocation.

`--api-drift` boots a fresh backend and fails if `modbench/src/wire/generated/api.ts`
has drifted from the live OpenAPI spec — any endpoint/DTO annotation change can
silently invalidate it, so it rides along with `--backend`, not `--frontend`.

The backend gates queue on a machine-wide flock, so a run can outlast a foreground command's
10-minute cap, and a subagent that ends its turn to wait has reported instead. Run
`run-gates.sh <flags> --detach`, then `run-gates.sh --wait` in the foreground until it prints the
verdict. Exit 3 means call it again.

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
