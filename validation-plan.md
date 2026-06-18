# Validation Plan

> **EXECUTE this plan immediately — do not re-plan or summarize it. Start Step 1 now.**

## Work Summary
Resolved TD-011: `DuckDbRecordRepository.GetRecord` and `GetAllOverrides` now cache `FindRecordType` results in a per-call `Dictionary<string, string?>`, eliminating up to 163 DuckDB queries per FormLink leaf. Added a regression test (`GetAllOverrides_SharedKeywordRef_CheckErrorConsistentAcrossOverrides`) verifying correct CheckError behavior across two override plugins sharing a keyword reference. Deleted `td-011-checkerror-builder-runs-uncached-on-every-read.md`.

## Files Changed
- `MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs`
- `MEditService/MEditService.Tests/Query/DuckDbRecordRepositoryTests.cs`
- `docs/tech-debt/td-011-checkerror-builder-runs-uncached-on-every-read.md` (deleted)
- `docs/tech-debt/td-010-fieldpath-grammar-parsed-independently.md` (deleted, from prior work on this branch)

## Scope
- Backend: yes
- Frontend: no
- Core CS (mutation eligible): yes
- Config/docs only: no

## Task Files
none

## Execution

### Step 1 — Mechanical gates
```bash
bash .claude/skills/validate/run-gates.sh --backend
```

All scope failures reported together — fix all, then rerun. With TDD, expect pass on first run.

### Step 2 — Simplify (LLM)
/simplify

Review findings with developer, propose which to accept/reject, and wait for the developers decision before continuing. If simplify changes logic (not just style), rerun Step 1. If you're unsure or if something seems low priority, use /rubber-duck. Larger architectural refactors out of scope of the current task require the creation of a td-xxx.md file in tech-debt.

### Step 3 — Code review (LLM)
/code-review

Review findings with developer, propose which to accept/reject, and wait for the developers decision before continuing. If any changes are made, rerun Step 1. Any larger findings requiring architectural refactoring should be prompted to the developer for potential creation of a /handoff document to address the finding.

### Step 4 — Mutation tests (only if Core CS changed)
```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh
```
Triage survivors per /mutation-test.

## Completion
When all steps pass:
1. Update task files listed above (none)
2. `rm validation-plan.md`

## Git Workflow

### Branch
If the current branch is `main`, create a feature branch before committing:
```bash
git checkout -b td-011-cache-findrecordtype-per-read
```
This also enables `--since` in the mutation test step — Stryker compares `HEAD` against `main` and scopes automatically to changed files.

### Commit
Create a commit with a message referencing the task and summarizing the work, e.g. "Cache FindRecordType results per read call to eliminate redundant DuckDB queries [TD-011]". Prompt the user to review and edit the commit message before finalizing. Then commit the changes.

### Merge
After the commit is approved, merge the feature branch back to `main`:
```bash
git checkout main && git merge --no-ff td-011-cache-findrecordtype-per-read
```
