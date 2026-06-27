# Validate

Creates `validation-plan.md` to hand off to a fresh session. Run at end of any implementation task.

## Step 1 — Determine scope

```bash
git diff --name-only HEAD && git diff --name-only --cached
```

Classify each changed file:

- **Backend**: `MEditService/**/*.cs`
- **Frontend**: `medit-vscode/**/*.ts`, `medit-vscode/**/*.tsx`, `package.json`, `src/generated/api.ts`
- **Core CS** (mutation eligible): `MEditService/MEditService.Core/**/*.cs`
- **Config/docs only**: nothing in Backend or Frontend buckets

## Step 2 — Determine run-gates command

From scope, build the exact command:

| Scope | Flags |
|-------|-------|
| Backend only | `bash .claude/skills/validate/run-gates.sh --backend` |
| Frontend only | `bash .claude/skills/validate/run-gates.sh --frontend` |
| Both | `bash .claude/skills/validate/run-gates.sh --backend --frontend` |
| Config/docs only | *(omit Step 1 from execution plan)* |

## Step 3 — Identify task files

Include any task `.md` files explicitly in use during this session (known from conversation context — do not scan). If none, write "none".

## Step 4 — Write `validation-plan.md`

Write to the project root:

```markdown
# Validation Plan

> **EXECUTE this plan immediately — do not re-plan or summarize it. Start Step 1 now.**
> **Check off each item in this file as you complete it — do not wait until the end.**

## Work Summary

<1–3 sentences describing what was implemented or changed>

## Files Changed

<file list from git diff>

## Scope

- [ ] Backend: yes/no
- [ ] Frontend: yes/no
- [ ] Core CS (mutation eligible): yes/no
- [ ] Config/docs only: yes/no

## Task Files

<list of paths and what to mark complete, or "none">

## Execution

### Step 1 — Mechanical gates

- [ ] Run: `<exact command from Step 2 above>`

All scope failures reported together — fix all, then rerun. With TDD, expect pass on first run.

### Step 2 — Simplify (LLM)

- [ ] Run `/simplify`
- [ ] Review findings, decide whether to accept, reject, or surface to developer for further analysis. Small but unrelated findings should be addressed. Significant findings requiring larger refactoring should be surfaced to the developer or addressed immediately if serious.
- [ ] If simplify changes logic (not just style), rerun Step 1

### Step 3 — Code review (LLM)

- [ ] Run `/code-review`
- [ ] Review findings, decide whether to accept, reject, or surface to developer for further analysis. Small but unrelated findings should be addressed. Significant findings requiring larger refactoring should be surfaced to the developer or addressed immediately if serious.
- [ ] If any changes are made, rerun Step 1


### Step 4 — Branch & commit (required before mutation tests)

- [ ] If current branch is `main`, create feature branch: `git checkout -b <short-slug-describing-the-work>`
- [ ] Stage and commit with message referencing the task. If multiple tasks, list them all. If no explicit tasks, write "no task file".
- [ ] Prompt the user to review and edit the commit message before finalizing.

The commit must exist on a feature branch before running mutation tests — Stryker's `--since` flag diffs `HEAD` against `main` to scope mutations to changed files only.

### Step 5 — Mutation tests (only if Core CS changed)

Mutation runs are scoped to changed files (`since: main`). Pick cadence by where you are:

- **Per-subtask validate** — run mutation **targeted** at the methods you just changed, not the
  full changed-files corpus:
  `cd MEditService && bash ../.claude/skills/mutation-test/run.sh --file <ChangedFile>.cs`
- **Phase-end validate** — run the full changed-files scope **once**:
  `cd MEditService && bash ../.claude/skills/mutation-test/run.sh`

- [ ] Triage survivors per /mutation-test
- [ ] **Confirm each triaged fix with a targeted run** (`run.sh --mutant-ids <id>` / `--file`).
  **Never re-run the full corpus to confirm a fix** — a full run can take ~an hour.

The terminal window that opens shows live `%`-progress for the developer to watch; the agent
just waits for the script to return and reads only the printed summary.

### Step 6 — Completion & Merge
- [ ] For each task file listed above: set Status to complete, fill in Proof section with test output and commit hash, then move to `docs/tasks/completed-tasks/`
- [ ] `rm validation-plan.md`
- [ ] After mutation tests pass and any survivors are triaged, merge back to `main`: `git checkout main && git merge --no-ff <branch>`
```

## Step 5 — Hand off

Tell the user `validation-plan.md` is ready. Starting a new session to execute it is the implicit approval.
