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
- [ ] Review findings with developer, propose which to accept/reject, and wait for decision
- [ ] If simplify changes logic (not just style), rerun Step 1

If you're unsure or if something seems low priority, use /rubber-duck. Larger architectural refactors out of scope of the current task require the creation of a td-xxx.md file in tech-debt.

### Step 3 — Code review (LLM)
- [ ] Run `/code-review`
- [ ] Review findings with developer, propose which to accept/reject, and wait for decision
- [ ] If any changes are made, rerun Step 1

Any larger findings requiring architectural refactoring should be prompted to the developer for potential creation of a /handoff document to address the finding.

### Step 4 — Mutation tests (only if Core CS changed)
- [ ] Run: `cd MEditService && bash ../.claude/skills/mutation-test/run.sh`
- [ ] Triage survivors per /mutation-test

## Git Workflow

### Branch
- [ ] If current branch is `main`, create feature branch: `git checkout -b <short-slug-describing-the-work>`

This also enables `--since` in the mutation test step — Stryker compares `HEAD` against `main` and scopes automatically to changed files.

### Commit
- [ ] Stage and commit with message referencing the task. If multiple tasks, list them all. If no explicit tasks, write "no task file".
- [ ] Prompt the user to review and edit the commit message before finalizing.

### Merge
- [ ] After the commit is approved, merge the feature branch back to `main`: `git checkout main && git merge --no-ff <branch>`

## Completion
- [ ] Update task files listed above
- [ ] `rm validation-plan.md`
```

## Step 5 — Hand off

Tell the user `validation-plan.md` is ready. Starting a new session to execute it is the implicit approval.
