# Mutation Test Remediation

**Baseline run:** 2026-06-06, 96.98% score  
**Report:** `MEditService/StrykerOutput/2026-06-06.07-00-07/reports/mutation-report.json`  
**Total outstanding:** 4 survivors + 17 no-coverage = 21 mutants across 2 files

---

## Summary Table

| # | Group | File | Lines | Mutants | Action | Status |
|---|-------|------|-------|---------|--------|--------|
| A | Array-of-Loqui Apply | SchemaReflector.cs | 520, 523, 532, 549, 554 | 3 NoCoverage + 2 Survived | Write tests | ✅ |
| B | Struct Apply | SchemaReflector.cs | 592, 603, 606, 607, 610 | 4 NoCoverage + 2 Survived | Write tests | ✅ |
| C | `long` primitive | SchemaReflector.cs | 298 (×3) | 3 NoCoverage | Write test or Delete | ✅ |
| D | Enum Apply | SchemaReflector.cs | 472 | 1 NoCoverage | Write test | ✅ |
| E | Defensive dead code | SchemaReflector.cs | 54, 215, 420, 445 | 4 NoCoverage | Simplify / Suppress | ✅ |
| F | Staged load order | RecordQueryService.cs | 65 | 1 NoCoverage | Write test | ✅ |

**Workflow per group:** propose → developer approves → implement → rerun `run.sh --file <file>` → mark done.

---

## Group A — Array-of-Loqui Apply lambda (SchemaReflector.cs ~516–567)

**Mutants:**
- `[NoCoverage]` :520 — `if (json.ValueKind != JsonValueKind.Array) return;`
- `[NoCoverage]` :523 — `if (rp == null) return;`
- `[Survived]`   :532 — `Type? setterType = capturedIsLoqui ? listType.GetGenericArguments()[0] : null;`
- `[Survived]`   :549 — `else if (capturedIsLoqui && setterTyT## Group F — Staged records load order index (RecordQueryService.cs:65)

**Mutants:**
- `[NoCoverage]` :65 — `?.LoadOrderIndex ?? -1` (mutation: `-1` → `+1`)

**Root cause:** Existing staged-record tests don't assert the `LoadOrderIndex` value on returned summaries, and don't cover the scenario where the queried plugin is absent from `RequireSession().Plugins`.

**Proposed test** in `RecordQueryServiceTests.cs`:
```
GetRecords_ByPlugin_StagedOnlyRecords_UnknownPlugin_HasNegativeOneLoadOrderIndex
```
Set up a session where a plugin has staged records but is **not in the session's Plugins list**. Assert that the returned `RecordSummary.LoadOrderIndex == -1`.

---

## Remediation Order

1. **F** — isolated, single file, simple test
2. **D** — single test, can be done with A/B
3. **A** — SchemaReflector array apply
4. **B** — SchemaReflector struct apply
5. **C** — depends on Mutagen grep result
6. **E** — requires developer approval on suppressions

After each group: `cd MEditService && bash ../.claude/skills/mutation-test/run.sh --file <file>.cs`  
After all groups: `cd MEditService && bash ../.claude/skills/mutation-test/run.sh --all`
