# Mutation Test

Stryker.NET mutation tests against `MEditService.Core`. Commands from `MEditService/`.

## Always run fresh — never reuse a previous run

Don't cite results from prior runs — scope may differ, stale results give false confidence. Always run for current files.

## Running the report

> ⚠️ **Never read `mutation-report.json` directly.** Files are 2–3 MB with full source embedded. Always run `run.sh` (calls `parse-report.py`) — only the summary reaches context.

```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh
```

Scope to all Core (`since` disabled):

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

Allow up to 3 minutes. `run.sh` prints scope before running. Exits 0 if all killed, 1 if any survivors or NoCoverage remain.

Run parser against existing report (re-read without re-running):

```bash
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py
cd MEditService && python ../.claude/skills/mutation-test/parse-report.py StrykerOutput/<dated-run>/reports/mutation-report.json
```

## Performance

- **Initial test run** (~60s) — builds coverage map. Fixed overhead regardless of scope.
- **Mutation phase** — only mutants covered by at least one test are exercised; auto-scoping shrinks this to seconds.

## Reading the report

`parse-report.py` prints only issues requiring action. If none: `No issues found.`

Each issue: status (`[Survived]` or `[NoCoverage]`), file, line, mutator name, what changed, 3-line source context with mutated lines marked `>>>`.

## Handling survivors

Don't fix survivors directly. Analyze → plan → get approval → dispatch subagents.

**Propose an action for each survivor** using this triage order (stop at first that applies):

- **Delete** — code guards impossible state; remove it
- **Simplify** — overcomplicated (e.g. `?? ""` on non-nullable); simplify so mutant ceases to exist
- **Write a test** — necessary logic; write a test that fails on the mutant
- **Refactor** — no test writable (hidden dependency, unreachable branch); expose the seam
- **Suppression** — last resort; flag explicitly for developer approval

**Group survivors** that would be resolved by the same change (same file/method, same new test case). Each group becomes one subagent task.

**Present the plan to the developer** — per group: which survivors, proposed action, one-sentence rationale. Wait for approval before continuing. If any proposal is for suppression, explicit developer yes is required before that group proceeds.

**Dispatch one subagent per approved group.** Each subagent brief must state: the survivors it owns, the approved action, and **not to run mutation tests** — the orchestrating agent reruns after all subagents complete.

**Rerun `run.sh`** after all subagents finish. Repeat from the top for any new survivors.

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

## Common mutator names

| Mutator | What it changes |
| ------- | --------------- |
| `ConditionalBoundary` | `>` ↔ `>=`, `<` ↔ `<=` |
| `Equality` | `==` ↔ `!=` |
| `LogicalOperator` | `&&` ↔ `\|\|` |
| `StringLiteral` | string contents |
| `Arithmetic` | `+` ↔ `-`, `*` ↔ `/` |
| `BooleanLiteral` | `true` ↔ `false` |
| `NullCoalescing` | `??` removal |
| `RemoveConditional` | removes `if` condition |

## Known issues

- Initial test run is slow (~60s) — Mutagen types and DuckDB infrastructure load. Fixed overhead, can't be scoped away.
- `CompileError` mutants from `DuckDbRecordRepository.Index` and `SchemaReflector.GetSubFieldInfo` are expected — Stryker can't mutate `out` variable patterns there. Counted and ignored automatically.
