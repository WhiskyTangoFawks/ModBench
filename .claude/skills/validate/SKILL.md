---
name: validate
description: Post-implementation review-and-ship workflow. Run at the end of any coding task — mechanical gates, report-only /code-review triage, autonomous commit/push, mutation tests, and merge.
---

# Validate

Run after any implementation task. Size picks the path (Step 0). Review = one **report-only `/code-review`**; the agent triages and applies — the reviewer never edits.

## Step 0 — Size

**Small** (ALL): ≤ ~3 files · no `MEditService.Core` logic change · one context · low blast radius.
**Large**: anything else, or when in doubt.

- Small → run Steps 1–5 inline; no `validation-plan.md`.
- Large → write `validation-plan.md` (below), hand off to a fresh session.

## Step 1 — Gates

```bash
git diff --name-only HEAD && git diff --name-only --cached
```

Classify changed files → run matching gate (never review non-compiling code):

| Changed | Command |
|---|---|
| `MEditService/**/*.cs` | `bash .claude/skills/validate/run-gates.sh --backend` |
| `medit-vscode/**` | `… --frontend` |
| both | `… --backend --frontend` |
| config/docs only | skip |

Fix all failures, rerun. Core CS (`MEditService/MEditService.Core/**/*.cs`) = mutation-eligible → Step 4.

## Step 2 — Review

1. Run `/code-review` **report-only** (no `--fix`; `high`/`ultra` for large/risky). One pass covers correctness + reuse/simplification/efficiency — do **not** also run `/simplify` (duplicate).
2. Triage every finding (first match):

| Outcome | When → Action |
|---|---|
| **Fix now** | in scope, or cheap + adjacent → apply |
| **Defer** | valid, out of scope/large → `gh issue create` (`tech debt` + `ready-for-agent`\|`needs-triage`); body = finding + analysis + rec; link it |
| **Escalate** | ambiguous / wide blast radius → ask dev: fix / ignore / issue |
| **Reject** | not real → note why |

3. Rerun Step 1 gates if any fix changed logic.

Complexity / quality notes are not a validate step: the `code-quality` Stop hook surfaces them continuously during the work, scoped to changed files, for in-loop triage. Validate owns correctness, gates, and mutation — not the complexity re-check.

## Step 3 — Commit & push

- On `main` → `git checkout -b <slug>`.
- Commit autonomously — reference issue/task, `Co-Authored-By` trailer, no message-review prompt.
- `git push -u origin <branch>`.

Must precede mutation (Stryker `--since` diffs `HEAD`..`main`).

## Step 4 — Mutation (Core CS logic only)

Mutation testing here is a **spec-audit / entropy tool, not a score gate** — the goal is
to **disposition every survivor, not drive to zero.** Scoped `since: main`:

- Per-subtask: `cd MEditService && bash ../.claude/skills/mutation-test/run.sh --file <File>.cs`
- Phase-end: `… run.sh` (full changed-files, once)

Triage survivors per `/mutation-test` (9-way, gating question first). Apply
**Delete / Refactor / Simplify / Fix-coupling / kill autonomously**. Do **not** apply
Accepts (unproductive/equivalent) or any suppression mid-flow — collect them, and every
survivor, into a **disposition ledger** in the validate summary:

```
<file>:<line> [mutator] → killed | deleted | simplified | accepted:<reason> | request-fixture:<condition>
```

`request-fixture` **pauses that survivor**: surface the request to the developer (a real
plugin exhibiting the malformed-data condition) — do not accept or delete it until the
fixture arrives and a behavioral test is written. Confirm each applied fix targeted
(`--mutant-ids`/`--file`); **never** full re-run (~1h). Read only the returned summary.

## Step 5 — Merge & complete

- **Ledger review (dead-code veto):** present the Step 4 disposition ledger's proposed
  `accepted:`/suppression entries to the developer before merge. Approved → apply the
  suppression now (config-level per `/mutation-test`). Rejected → fall back to Delete or
  a real red-green cycle. Unresolved `request-fixture` survivors block completion of that
  slice until the fixture + test land. Nothing is permanently silenced without sign-off.
- Task files → Status complete + Proof (test output + commit hash) → move to `docs/tasks/completed-tasks/`.
- `git checkout main && git merge --no-ff <branch> && git push`.
- Large path → `rm validation-plan.md`.

---

## Handoff template (large path)

Write to project root; tell the user. New session = approval.

```markdown
# Validation Plan
> EXECUTE now — do not re-plan. Check off inline. You did not write this code; review independently.

Work:  <what changed + issue #>
Files: <git diff --name-only>
Scope: backend? · frontend? · Core CS (mutation)? · config/docs?
Tasks: <paths + what to complete, or none>

Run /validate Steps 1–5:
- [ ] 1 Gates: `<cmd>`
- [ ] 2 `/code-review` report-only → triage (fix / defer-issue / escalate / reject) + apply
- [ ] 3 Branch, commit (autonomous), push
- [ ] 4 Mutation (Core CS logic only)
- [ ] 5 Task files complete, merge --no-ff, push, rm validation-plan.md
```
