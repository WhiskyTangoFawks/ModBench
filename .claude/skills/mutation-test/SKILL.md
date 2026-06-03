# Mutation Test

Run Stryker.NET mutation tests against `MEditService.Core`. All commands run from `MEditService/`.

## Always run fresh — never reuse a previous run

Do not read or cite results from a prior Stryker run. The scope may have been different, and stale results give false confidence. Always execute the script for the files you are currently validating.

## Running the report

The script auto-scopes to Core files touched in the current diff (staged + unstaged + commits ahead of main), patches `stryker-config.json` at runtime, and restores it when done. Never edit `stryker-config.json` manually.

```bash
cd MEditService && python ../.claude/skills/mutation-test/stryker-report.py
```

To scope to all of Core instead:

```bash
cd MEditService && python ../.claude/skills/mutation-test/stryker-report.py --all
```

To rerun only specific mutant IDs (targeted verification — still pays the ~60s initial test run):

```bash
cd MEditService && python ../.claude/skills/mutation-test/stryker-report.py --mutant-ids 42 57
```

Allow up to 3 minutes for a full run. The script prints the computed scope before running so you can confirm it is correct.

The script exits 0 if all mutants killed, 1 if any survivors or NoCoverage mutants remain.

## Performance notes

- **Initial test run** (~60s) — Stryker builds a coverage map. Fixed overhead regardless of scope.
- **Mutation phase** — only mutants covered by at least one test are exercised. Auto-scoping shrinks this phase to seconds.

## Reading the report

The script prints each surviving or uncovered mutant with:
- File path and line number
- Mutator name and what the mutation changed
- 3 lines of source context with the mutated line marked `>>>`
- A ready-to-paste suppression snippet

Status meanings:
- **Killed** — caught by a test (good)
- **Survived** — not caught (test gap; investigate)
- **NoCoverage** — no test exercises this code at all
- **CompileError** — Stryker's mutation made the code uncompilable; skipped automatically. Two known offenders: `DuckDbRecordRepository.Index` and `SchemaReflector.GetSubFieldInfo` (both use `out` variable patterns that confuse Stryker). Always appear as compile errors — ignore them.

## Handling survivors

Triage each survivor in order. Stop at the first step that resolves it. **Never add a suppression without explicit developer approval** — ask the developer and wait for a yes before writing any `// Stryker disable` comment or adding an `ignore-mutants` entry. The only code that may go untested is logging, and that is handled via `stryker-config.json`, never via comment annotations.

**Step 1 — Delete the code:** If the survivor guards a state that cannot happen (dead code, redundant guard, inert check), remove it entirely. Dead code that cannot be tested should not exist.

**Step 2 — Simplify the code:** If the construct is correct but overcomplicated (e.g. a null-coalescing `?? ""` on a value that cannot be null, a redundant condition), simplify it so the mutant no longer exists.

**Step 3 — Write a test:** If the code is necessary and cannot be simplified, write a test that kills the mutant — one that fails on the mutated code and passes on the original.

**Step 4 — Refactor to make it testable:** If a test cannot be written in the current design (e.g. the dependency is hidden, the branch is unreachable from any test), refactor the code to expose the seam. Untestable code is not acceptable — a survivor that reaches this step means the design needs to change, not that a suppression is warranted.

**Suppression (requires explicit developer approval):** If you believe suppression is the only option after exhausting steps 1–4, stop and present the case to the developer. Do not write the annotation or config entry until you receive an explicit yes. If approved, use the format below.

## Suppression format (only after explicit developer approval)

### Source-level (line)

```csharp
// Stryker disable once <MutatorName>: <reason why the code exists> / <reason the mutation is inert>
someCode();
```

### Config-level (mutator category across the project — preferred over source annotations)

```json
"ignore-mutants": [
  { "mutant": "StringLiteral", "description": "Logging statements are not tested by design" }
]
```

Source-level annotations are a last resort even when suppression is approved — prefer a config-level entry for anything that applies project-wide. Annotations without reasoning (both why the code exists and why the mutation is inert) will be rejected in review.

### Common mutator names

| Mutator | What it changes |
|---|---|
| `ConditionalBoundary` | `>` ↔ `>=`, `<` ↔ `<=` |
| `Equality` | `==` ↔ `!=` |
| `LogicalOperator` | `&&` ↔ `\|\|` |
| `StringLiteral` | string contents |
| `Arithmetic` | `+` ↔ `-`, `*` ↔ `/` |
| `BooleanLiteral` | `true` ↔ `false` |
| `NullCoalescing` | `??` removal |
| `RemoveConditional` | removes `if` condition |

## Known issues

- The `progress` reporter crashes when Stryker is not attached to a real TTY. Use `"dots"` instead (already set in `stryker-config.json`).
- The initial test run is slow (~60s) because the test suite loads Mutagen types and DuckDB infrastructure. This is fixed overhead — cannot be avoided by scoping.
