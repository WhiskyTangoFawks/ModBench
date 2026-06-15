# Validation Plan

> **EXECUTE this plan immediately — do not re-plan or summarize it. Start Step 1 now.**

## Work Summary
Implemented phase 10.3 "Delete Records": backend orchestrator, PluginWriter Pass 3, `POST /records/delete` endpoint, and frontend `SessionController.deleteRecords` + `mEdit.deleteRecord` command with multi-select support and context-menu/keybinding wiring. Also fixed a pre-existing gap: `POST /records/{formKey}/copy-to/{targetPlugin}` endpoint was missing from the backend despite the frontend calling it — added the endpoint and regenerated `api.ts`.

## Files Changed
**Modified:**
- `MEditService/MEditService.Api/Endpoints/ChangeEndpoints.cs`
- `MEditService/MEditService.Core/Edits/EditOrchestrator.cs`
- `MEditService/MEditService.Core/Edits/IEditOrchestrator.cs`
- `MEditService/MEditService.Core/Edits/PluginWriter.cs`
- `MEditService/MEditService.Core/Queries/Models.cs`
- `MEditService/MEditService.Core/Schema/RecordTableSchema.cs`
- `MEditService/MEditService.Core/Schema/SchemaReflector.cs`
- `MEditService/MEditService.Tests/Api/ChangeApiTests.cs`
- `MEditService/MEditService.Tests/Changes/PluginWriterApplyTests.cs`
- `medit-vscode/package.json`
- `medit-vscode/src/SessionController.ts`
- `medit-vscode/src/extension.ts`
- `medit-vscode/src/generated/api.ts`
- `medit-vscode/src/test/SessionController.test.ts`
- `medit-vscode/src/test/integration/extension.test.ts`

**New:**
- `MEditService/MEditService.Core/Edits/DeleteRecordsResult.cs`
- `MEditService/MEditService.Core/Edits/PendingChangeConstants.cs`
- `MEditService/MEditService.Tests/Api/DeleteRecordsApiTests.cs`
- `MEditService/MEditService.Tests/Api/DeleteRecordsFixture.cs`
- `MEditService/MEditService.Tests/Edits/DeleteRecordsTests.cs`

## Scope
- Backend: yes
- Frontend: yes
- Core CS (mutation eligible): yes
- Config/docs only: no

## Task Files
- `docs/tasks/phase-B.md` — mark phase 10.3 complete

## Execution

### Step 1 — Mechanical gates
```bash
bash .claude/skills/validate/run-gates.sh --backend --frontend
```

All scope failures reported together — fix all, then rerun. With TDD, expect pass on first run.

### Step 2 — Simplify (LLM)
/simplify

Review findings with developer, propose which to accept/reject, and wait for the developer's decision before continuing. If simplify changes logic (not just style), rerun Step 1. Any larger findings requiring architectural refactoring should be prompted to the developer for potential creation of a /handoff document to address the finding.

### Step 3 — Code review (LLM)
/code-review

Review findings with developer, propose which to accept/reject, and wait for the developer's decision before continuing. If any changes are made, rerun Step 1. Any larger findings requiring architectural refactoring should be prompted to the developer for potential creation of a /handoff document to address the finding.

### Step 4 — Mutation tests (only if Core CS changed)
```bash
cd MEditService && bash ../.claude/skills/mutation-test/run.sh
```
Triage survivors per /mutation-test.

## Completion
When all steps pass:
1. Mark phase 10.3 complete in `docs/tasks/phase-B.md`
2. `rm validation-plan.md`

