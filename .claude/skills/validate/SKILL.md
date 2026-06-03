# Validate

Run the right validation gates for what actually changed. Stop at the first failure and fix it before continuing.

Use this skill at the end of any task before declaring it done.

---

## Step 0 — Determine scope

Run these two commands to see every file touched in this session:

```bash
git diff --name-only HEAD
git diff --name-only --cached
```

Classify the results:

| Area | Pattern |
|------|---------|
| **Backend** | `MEditService/**/*.cs` |
| **Frontend** | `medit-vscode/**/*.ts`, `medit-vscode/**/*.tsx`, `medit-vscode/package.json` |
| **API contract** | `medit-vscode/src/generated/api.ts` |
| **Config / docs only** | everything else |

Then select gates:

| Gate | Run when |
|------|----------|
| 1 — Simplify | Always |
| 2 — Backend lint | Any backend change |
| 3 — Backend tests | Any backend change |
| 4 — Frontend tests | Any frontend change, or api.ts regenerated |
| 5 — Mutation tests | Any `MEditService.Core/**/*.cs` change |
| 6 — Code review | Always |

If the only changes are config or docs (no `.cs`, `.ts`, `.tsx`), skip gates 2–5 and jump straight to Gate 6.

---

## Gate 1 — Simplify

Run `/simplify`. It will review and apply simplification, reuse, and efficiency cleanups to the changed code.

If it modifies files, continue to Gate 2 — the subsequent gates validate the simplified result.

---

## Gate 2 — Backend lint  *(backend changes only)*

Run `/lint-backend`. Both tools must pass with zero diagnostics.

If anything fails, fix it now. Do not proceed to Gate 3 until Gate 2 is clean.

---

## Gates 3 & 4 — Tests  *(run applicable gates in parallel as sub-agents)*

Gates 3 and 4 are independent. If both apply, spawn them as sub-agents in a **single message** so they run concurrently.

### Gate 3 — Backend tests  *(backend changes only)*

Spawn a sub-agent with this prompt (fill in the bracketed parts from your scope):

> Run `cd MEditService && dotnet test` from the repo root `/home/wayne/Games/FO4/mEdit`.
> Changed C# files: [list the files from Step 0].
> Report back: PASS or FAIL, total test count, and for any failures — the test name, the failure message, and the file+line where it failed. Nothing else.

**If the sub-agent reports FAIL:** fix the failures in the main window, then spawn a new Gate 3 sub-agent with the same prompt to verify. Repeat until green before continuing to Gate 5.

### Gate 4 — Frontend tests  *(frontend changes or api.ts regenerated)*

Spawn a sub-agent with this prompt:

> Run these two commands from the repo root `/home/wayne/Games/FO4/mEdit`:
> 1. `cd medit-vscode && npm run test:unit`
> 2. `cd medit-vscode && npm run test:integration`
> `test:integration` runs inside a real VS Code process and takes ~10s — wait for it.
> Report back: PASS or FAIL for each suite, and for any failures — the test name, the failure message, and the file+line. Nothing else.

**If the sub-agent reports FAIL:** fix the failures in the main window, then spawn a new Gate 4 sub-agent with the same prompt to verify. Repeat until green.

---

## Gate 5 — Mutation tests  *(MEditService.Core changes only; runs after Gate 3 passes)*

Gate 5 depends on Gate 3. Only spawn this after Gate 3 is green.

Spawn a sub-agent with this prompt:

> Run `cd MEditService && python ../.claude/skills/mutation-test/stryker-report.py` from the repo root `/home/wayne/Games/FO4/mEdit`.
> The script auto-scopes to changed Core files. Allow up to 3 minutes.
> Report back: overall PASS or FAIL, and for each Survived or NoCoverage mutant — the file, line number, mutator name, and the 3-line source context. Killed mutants need not be mentioned. Nothing else.

**If the sub-agent reports survivors:** triage each one in the main window per the rules in `/mutation-test`. Once triaged (tests added, code deleted, or suppression justified), spawn a new Gate 5 sub-agent with the same prompt to verify. Suppression requires rubber-duck sign-off before the re-run.

---

## Gate 6 — Code review

Run `/code-review`. Address any findings before declaring done.

---

## Declaring done

All applicable gates pass → the task is done.

If a gate cannot pass (e.g. a known pre-existing issue unrelated to your change), document why in your response. Do not silently skip gates.
