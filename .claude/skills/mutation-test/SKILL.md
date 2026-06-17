# Mutation Test

Stryker.NET mutation tests against `MEditService.Core`. Commands from `MEditService/`.

## Running the report

> ⚠️ **Never read `mutation-report.json` directly.** Files are 2–3 MB with full source embedded. Always run `run.sh` (calls `parse-report.py`) — only the summary reaches context.

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh
```

Scope to all Core (disables `since`, full corpus — slow):

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh --all
```

Single file:

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh --file ConflictClassifier.cs
```

Specific mutant IDs (still pays ~60s initial run):

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh --mutant-ids 42 57
```

`run.sh` prints scope before running. Exits 0 if all killed, 1 if any survivors or NoCoverage remain.

Run parser against existing report (re-read without re-running):

```bash
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py StrykerOutput/<dated-run>/reports/mutation-report.json
```

## Handling survivors

Don't fix survivors directly. Analyze → plan → get approval → fix inline.

**Propose an action for each survivor** using this triage order (stop at first that applies):

- **Delete** — code guards impossible state; remove it
- **Refactor duplicate** If code is duplicated, refactor so code is reusable, and can be covered by single test
- **Simplify** — overcomplicated (e.g. `?? ""` on non-nullable); simplify so mutant ceases to exist
- **Write a test** — necessary logic; write a test that fails on the mutant
- **Refactor** — no test writable (hidden dependency, unreachable branch); expose the seam
- **Suppression** — last resort; flag explicitly for developer approval

**Group survivors** that would be resolved by the same change (same file/method, same new test case).

**Present the plan to the developer** — per group: which survivors, proposed action, one-sentence rationale. Wait for approval before continuing. If any proposal is for suppression, explicit developer yes is required before that group proceeds.

**Fix each approved group inline**, one at a time. After all groups are done, rerun `run.sh`. Repeat from the top for any new survivors.

**Never suppress without explicit developer approval.** Only logging may go untested — handled via `stryker-config.json`, never comment annotations.

## Suppression format (only after explicit developer approval)

Config-level (preferred):

```json
"ignore-mutants": [
  { "mutant": "StringLiteral", "description": "Logging statements are not tested by design" }
]
```

Source-level (last resort):

```csharp
someCode(); // Stryker disable once StringLiteral: <reason>
```

Prefer config-level for anything project-wide. Annotations without reasoning (why the code exists, why the mutation is inert) will be rejected in review.

## Known issues

- `CompileError` mutants from `DuckDbRecordRepository.Index` and `SchemaReflector.GetSubFieldInfo` are expected — Stryker can't mutate `out` variable patterns there. Counted and ignored automatically.
