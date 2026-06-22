# Phase 13.4 — VMAD Scalar Editing (Backend)

**Status: Complete** · Parent: [phase-13](phase-13.md) · Depends on: 13.2 · **Model: Sonnet** *(foundational addressing/apply scheme that 13.6/13.7/13.8 inherit, but decisions already made in this doc; bump to Opus if you want extra care on the scheme)*

*Goal: a staged change addressing a single VMAD scalar property (Bool/Int/Float/String/Object) is applied to the plugin's VirtualMachineAdapter on save. This establishes the VMAD pending-change addressing scheme and apply path that 13.6/13.7/13.8 extend.*

No frontend here — staging is exercised via `EditOrchestrator` / the PATCH endpoint in tests. The UI lands in 13.5.

---

## Addressing scheme — synthetic FieldPath

VMAD reuses the existing `PendingChange` model ([Edits/PendingChange.cs](../../MEditService/MEditService.Core/Edits/PendingChange.cs)) with no schema change. A VMAD property is addressed by a synthetic `FieldPath` distinguishable by a reserved prefix:

```
VMAD\<ScriptName>\<PropertyName>
```

- The prefix `VMAD\` is the routing discriminator. Define it as a constant (e.g. `VmadPathPrefix` in `PendingChangeConstants` or a new `VmadPath` helper).
- `NewValue` JSON shape is **per property type**:
  - Bool → `true` / `false`
  - Int → number
  - Float → number
  - String → string
  - Object → `{ "formKey": "0xAABBCCDD:Plugin.esp", "alias": -1 }`
- Provide a small parser/formatter (`VmadPath`) that builds and destructures these paths and value payloads, shared with the frontend contract (document the shape; the frontend builds the same strings in 13.5).

> Why a synthetic path rather than a new pending-change *type*: VMAD scalar edits are conceptually field edits (`ChangeType = "field_edit"`), reusing revert, grouping, and pending-display plumbing unchanged. Only the *apply* routing differs. Structural ops (13.8) will introduce VMAD-specific change types.

---

## Staging — `EditOrchestrator` / `PluginWriter.IsReadOnly`

The current staging path rejects unknown field paths:

- `EditOrchestrator.StageEdit` calls `_writer.IsReadOnly(release, recordType, fieldPath)` ([PluginWriter.cs:89](../../MEditService/MEditService.Core/Edits/PluginWriter.cs#L89)), which returns true when no `RecordColumns` entry matches — a VMAD path would be wrongly rejected as read-only.
- [ ] Teach `IsReadOnly` (or short-circuit before it) to recognize VMAD paths: a VMAD scalar path of an editable type is **not** read-only; a Variable/ArrayOfVariable path **is** read-only.
- [ ] `oldValues` capture in `StageEdit` reads from `currentRecord.Fields` — VMAD properties are not in `Fields`. Capture the VMAD old value via `GetVmad(formKey, plugin)` lookup instead (needed for correct revert/diff). Keep this path isolated so generic field staging is untouched.
- [ ] Reference validation: an Object property's FormKey should go through the same `ValidateReferences` / `ExtractFormKeyRefs` flow so saving a VMAD Object edit updates `form_references`. Wire VMAD Object paths into `ExtractFormKeyRefs`.

---

## Apply — `PluginWriter`

In [PluginWriter.cs](../../MEditService/MEditService.Core/Edits/PluginWriter.cs):

- [ ] In `ApplyFieldChanges` / `TryApplyField`, branch on the VMAD path prefix **before** the `RecordColumns` lookup. Route VMAD field changes to a new `ApplyVmadField(IMajorRecord record, PendingChange change)`.
- [ ] `ApplyVmadField`:
  1. Cast record to `IHaveVirtualMachineAdapter`; get the mutable `VirtualMachineAdapter`. Bail to `NotFound` if absent.
  2. Parse the path → `(scriptName, propertyName)`. Find the `ScriptEntry` by name, then the `ScriptProperty` by name.
  3. Dispatch on concrete property type and set the value:
     - `ScriptBoolProperty.Data`, `ScriptIntProperty.Data`, `ScriptFloatProperty.Data`, `ScriptStringProperty.Data` (verify exact mutable member names against `Script*Property_Generated.cs`).
     - `ScriptObjectProperty`: set `.Object.FormKey` and `.Alias`.
  4. Return `Applied` / `NotFound` / `ReadOnly` (Variable → ReadOnly).
- [ ] The existing write pipeline (`PrepareAsync` → `BeginWrite`) already re-serializes the whole mod, so VMAD custom binary translation round-trips automatically once the in-memory adapter is mutated. No VMAD-specific write code needed beyond the setter.

> Note: scalar **value** edits do not change property type or array length, so the Object Format (1 vs 2) and property ordering are untouched — Mutagen preserves them. Verify a round-trip leaves unrelated scripts/properties byte-stable in a test.

---

## Index refresh after save

- [ ] After save, the committed read model must reflect the edit. Confirm the post-save re-index path re-runs the VMAD import walk (13.1) for the written plugin, so `GetVmad` returns the new value. If the save path does a targeted re-index, ensure VMAD tables are included.

---

## Tests

- [ ] Staging a VMAD Bool edit and saving flips the value in the written plugin (re-read via Mutagen or `GetVmad` after re-index).
- [ ] Saving a VMAD String edit writes the new string.
- [ ] Saving a VMAD Object edit writes the new FormKey + alias and adds a `form_references` row.
- [ ] A round-trip save of an unchanged adapter leaves other scripts/properties intact (no reordering / data loss).
- [ ] Staging an edit to a Variable-typed property is rejected as read-only.
- [ ] Editing one property of one script does not disturb sibling properties/scripts.

---

## Proof

Commit: `d9f00d4` (branch `phase-13.4-vmad-scalar-editing`)

```text
Passed!  - Failed: 0, Passed: 647, Skipped: 0, Total: 647, Duration: 2m 18s
```

Mutation tests: exit 0, no survivors, no NoCoverage.

New tests (647 − 638 baseline = 9 new):

- `PluginWriterVmadTests`: 8 writer-level tests (Bool/String/Object/sibling/NotFound cases)
- `EditOrchestratorVmadTests`: 7 orchestrator tests (Variable rejected, Bool old-value, Object form-ref, Array rejected, unknown script, unknown property, malformed path)
- `VmadPathTests`: 5 path parsing tests (valid, non-VMAD prefix, empty script/prop, no separator)
