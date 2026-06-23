# Validation Plan

> **EXECUTE this plan immediately — do not re-plan or summarize it. Start Step 1 now.**
> **Check off each item in this file as you complete it — do not wait until the end.**

## Work Summary

Phase 13.7 — VMAD Struct & ArrayOfStruct editing. Made the `VmadPropertyNode` (de)serializer recursive so struct members can themselves be structs; added recursive Struct/ArrayOfStruct apply to `PluginWriter` (re-wrapping the unnamed `ScriptEntry`, preserving member flags); recursed VMAD form-reference extraction into struct members; added a per-plugin `Raw` editable subtree to the `VmadPropertyDiff` wire model; and wired the frontend `VmadSection` to edit nested struct members, remove members, and add/remove ArrayOfStruct elements as one atomic-column restage.

## Files Changed

- MEditService/MEditService.Core/Edits/PluginWriter.cs
- MEditService/MEditService.Core/Queries/Models.cs
- MEditService/MEditService.Core/Queries/VmadConflictClassifier.cs
- MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs
- MEditService/MEditService.Core/Records/VmadIndexer.cs
- MEditService/MEditService.Core/Schema/VmadJson.cs
- MEditService/MEditService.Tests/Changes/PluginWriterVmadTests.cs
- MEditService/MEditService.Tests/Indexing/FormReferencesTests.cs
- MEditService/MEditService.Tests/Query/GetVmadTests.cs
- MEditService/MEditService.Tests/Query/VmadConflictClassifierTests.cs
- medit-vscode/src/generated/api.ts
- medit-vscode/webview/src/VmadSection.tsx
- medit-vscode/webview/src/VmadSection.test.tsx
- medit-vscode/webview/src/types.ts

Note: `.claude/skills/mutation-test/SKILL.md` is also modified but is a pre-existing change unrelated to this task.

## Scope

- [x] Backend: yes
- [x] Frontend: yes
- [x] Core CS (mutation eligible): yes
- [ ] Config/docs only: no

## Task Files

- docs/tasks/phase-13.7.md — mark Status complete, fill Proof, move to docs/tasks/completed-tasks/

## Execution

### Step 1 — Mechanical gates

- [x] Run: `bash .claude/skills/validate/run-gates.sh --backend --frontend`
      (Already passed this session: backend 663 tests + format + build; frontend 245 unit + 4 integration. Re-run after any further changes.)

### Step 2 — Simplify (LLM)

- [x] Run `/simplify`
- [x] Review findings; accept small/unrelated cleanups, surface larger refactors. If logic changes, rerun Step 1.

### Step 3 — Code review (LLM)

- [x] Run `/code-review`
- [x] Review findings; if any changes made, rerun Step 1.

### Step 4 — Branch & commit (required before mutation tests)

- [ ] Current branch is `main` — create feature branch: `git checkout -b phase-13.7-vmad-struct-editing`
- [ ] Stage and commit referencing phase-13.7 (exclude the unrelated `.claude/skills/mutation-test/SKILL.md` change unless intended).
- [ ] Prompt the user to review/edit the commit message before finalizing.

### Step 5 — Mutation tests (Core CS changed)

- [ ] Run: `cd MEditService && bash ../.claude/skills/mutation-test/run.sh`
- [ ] Triage survivors per /mutation-test (focus: PluginWriter struct/struct-list apply, VmadIndexer recursion + form-refs, VmadConflictClassifier BuildRaw/ToNode, DuckDbRecordRepository MapNode Struct branch).

### Step 6 — Completion & Merge

- [ ] Set docs/tasks/phase-13.7.md Status to complete, fill Proof (test output + commit hash), move to docs/tasks/completed-tasks/
- [ ] `rm validation-plan.md`
- [ ] Merge to main: `git checkout main && git merge --no-ff phase-13.7-vmad-struct-editing`
