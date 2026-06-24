# Phase 13 — VMAD (Papyrus Script Data)

**Status: Not Started**

*Goal: Papyrus script attachments (VMAD subrecord) appear in the compare grid as first-class, **fully editable** fields — scripts sorted by name, properties within each script sorted by name — reaching TES5Edit parity. Scripts and properties can be viewed, edited, added, and removed; property values of every type except Variable are editable.*

---

## Background

VMAD (Virtual Machine Adapter) is the Papyrus scripting subrecord present on NPC_, QUST, PERK, PACK, SCEN, INFO, ACTI, BOOK, and many other major records. Its structure:

```
VMAD
  Version          (int16, cpIgnore)
  Object Format    (int16, cpIgnore — 1 or 2; controls Object property field order)
  Scripts[]        sorted array, sort key = ScriptName
    ScriptName     (string)
    Flags          (enum: Local / Inherited / Removed / Inherited and Removed)
    Properties[]   sorted array, sort key = propertyName
      propertyName (string)
      Type         (enum: 14 active variants — see table below)
      Flags        (enum: Edited 0x01 / Removed 0x03)
      Value        (union — dispatched on Type)
```

For PERK, PACK, QUST, SCEN, INFO: a `ScriptFragments` section follows Scripts. **Out of scope for Phase 13** (see Out of Scope).

### Property value types (the union)

From `ScriptProperty.Type` (Mutagen) / `wbPropTypeEnum` (xEdit `wbDefinitionsFO4.pas`):

| # | Type | Storage | Editable in 13 | Notes |
|---|------|---------|----------------|-------|
| 1 | Object | FormKey + Alias(s16) + Unused(u16) | ✅ 13.4/13.5 | Field order depends on Object Format (1 vs 2); Mutagen handles ordering |
| 2 | String | string | ✅ 13.4/13.5 | |
| 3 | Int | int32 | ✅ 13.4/13.5 | |
| 4 | Float | float | ✅ 13.4/13.5 | |
| 5 | Bool | bool (u8) | ✅ 13.4/13.5 | |
| 6 | **Variable** | **none** | ❌ never | `{06} wbNull` in xEdit — carries no payload; xEdit cannot edit it either. Mutagen throws on parse. Excluding it **is** parity. See "Variable" below. |
| 7 | Struct | recursive list of named members (each a full property) | ✅ 13.7 | |
| 11 | ArrayOfObject | list of Object | ✅ 13.6 | |
| 12 | ArrayOfString | list of string | ✅ 13.6 | |
| 13 | ArrayOfInt | list of int32 | ✅ 13.6 | |
| 14 | ArrayOfFloat | list of float | ✅ 13.6 | |
| 15 | ArrayOfBool | list of bool | ✅ 13.6 | |
| 16 | **ArrayOfVariable** | **element count only** | ❌ never | `wbStruct('Array of Variable', [Element Count: u32])` in xEdit — no element structure. |
| 17 | ArrayOfStruct | list of Struct | ✅ 13.7 | |

### The "Variable" non-gap

The developer asked whether Variable being non-round-trippable in Mutagen is a parity gap. **It is not.** In `wbDefinitionsFO4.pas` xEdit defines Variable (type 6) as `wbNull` (zero payload bytes) and Array-of-Variable (type 16) as a bare `Element Count` u32 with no element body. Neither tool can edit Variable contents because there is nothing to edit. Variable properties are essentially never emitted by the Papyrus compiler.

The only real consequence: Mutagen's `ParseProperty` throws `NotImplementedException` for `ScriptVariableProperty` / `ScriptVariableListProperty`. So the import walk (13.1) **must catch per-record** — a single stray Variable property must skip/degrade that record's VMAD, not abort the whole index pass.

### Why VMAD is not in the generic reflection pipeline

The property `Value` is a polymorphic union. Mutagen represents it via custom binary translation in `AVirtualMachineAdapter` — it does not surface as standard getter-interface properties that `SchemaReflector` can walk. Teaching `SchemaReflector` about union types is larger scope than the VMAD feature itself. VMAD therefore gets dedicated DuckDB tables, a dedicated import/hydration path, and a dedicated apply path in `PluginWriter`.

**Architecture reference**: `SFRecordCompareEngine/` (sibling project at repo root) solved the read/import side identically — dedicated tables per VMAD entity with a typed flat schema, separate import + hydration services. See:
- `SFRecordCompareEngine.Core/Services/ScriptingAdapterImportService.cs`
- `SFRecordCompareEngine.Core/Services/ScriptingAdapterHydrationService.cs`
- `SFRecordCompareEngine.Core/DTOs/Records/ScriptingAdapterPropertyDTO.cs`

Note: the SF engine is **read-only** and does **not** handle Struct nesting. The editing path and struct support in this phase are new.

### Mutagen API names (verified)

- Interface (getter): `IHaveVirtualMachineAdapterGetter` — `record.VirtualMachineAdapter` returns `IVirtualMachineAdapterGetter?`. *(The original draft of this doc said `IHasVirtualMachineAdapterGetter` — that type does not exist.)*
- Interface (setter): `IHaveVirtualMachineAdapter`.
- Scripts: `IVirtualMachineAdapterGetter.Scripts` → `IReadOnlyList<IScriptEntryGetter>`; entry has `Name`, `Flags`, `Properties`.
- Property concrete types: `ScriptObjectProperty`, `ScriptStringProperty`, `ScriptIntProperty`, `ScriptFloatProperty`, `ScriptBoolProperty`, `ScriptStructProperty`, `Script*ListProperty`, plus `ScriptVariableProperty` (throws). Dispatch via `switch (property)` on concrete type — see `AVirtualMachineAdapter.cs` `WriteProperty`.
- `ScriptObjectProperty`: `.Object` (FormLink), `.Alias` (short), `.Unused` (ushort).
- `ScriptStructProperty.Members` → `ExtendedList<ScriptEntry>` (recursive); `ScriptStructListProperty.Structs`.

---

## Sub-phases

| Phase | Goal | Depends on | Model |
| ----- | ---- | ---------- | ----- |
| [13.1](phase-13.1.md) | Backend index — DuckDB tables + import walk (scalars, scalar-arrays, struct-as-JSON, Object→`form_references`, defensive Variable handling) | — | Sonnet |
| [13.2](phase-13.2.md) | Backend query, compare & **conflict detection** — `GetVmad`, cross-plugin alignment into a `FieldDiff`-shaped diff, per-cell `ConflictThis` + record `ConflictAll`, `vmad` in compare response, API + `generate-api` | 13.1 | **Opus** |
| [13.3](phase-13.3.md) | Frontend read-only display — VMAD section in compare grid (scripts → properties → struct members) with per-cell conflict coloring | 13.2 | Sonnet |
| [13.4](phase-13.4.md) | Backend scalar editing — VMAD pending-change addressing + `PluginWriter` apply for Bool/Int/Float/String/Object | 13.2 | Sonnet |
| [13.5](phase-13.5.md) | Frontend scalar editing — per-type edit widgets, pending column, revert | 13.3, 13.4 | Sonnet |
| [13.6](phase-13.6.md) | Scalar-array editing — `ArrayOf{Int,Float,Bool,String,Object}`, atomic-column model (ADR-0019), full stack | 13.5 | Sonnet |
| [13.7](phase-13.7.md) | Struct + ArrayOfStruct editing — recursive nested member editor, full stack | 13.5 | **Opus** |
| [13.8](phase-13.8.md) | Structural ops — add/remove scripts, add/remove properties, change property type, edit flags (split into [13.8.1](phase-13.8.1.md)–[13.8.4](phase-13.8.4.md)) | 13.5 | **Opus** |

*Model column = recommended Claude model for implementing each sub-phase (Opus for the conflict-classification integration and the two recursive/structural editing phases; Sonnet for the well-specified, reuse-heavy, or pattern-mirroring phases). 13.1 and 13.4 are borderline — both are Sonnet-doable but introduce foundations (`VmadJson` serializer; the addressing/apply scheme) that later phases inherit, so consider Opus there if you want to over-invest early.*

**Read-only foundation:** 13.1 → 13.2 → 13.3 (this is the original Phase 13 scope, minus the editing deferral).
**Common-case editing:** 13.4 → 13.5.
**Full parity:** 13.6, 13.7, 13.8 can each proceed independently once 13.5 lands (13.6/13.7/13.8 have no ordering between them, though they touch overlapping files so coordinate merges).

---

## Key Decisions

- **No editing deferral.** TES5Edit parity is the bar: scripts and properties are viewable, editable, addable, and removable; every property value type except Variable/ArrayOfVariable is editable. (Decision: 2026-06-21.)
- **Variable / ArrayOfVariable are display-only**, matching xEdit, which also cannot edit them (see Background). Not a gap.
- **Struct/ArrayOfStruct stored as JSON** on `vmad_properties` (`struct_json` column), not as recursive relational rows. Scalars and scalar-arrays stay relational (typed columns + `vmad_property_list_items`). Rationale: the read model only needs to *reconstruct* the struct tree for display/edit, never query into struct internals; a self-referencing recursive table is disproportionate complexity. See 13.1.
- **VMAD pending changes use a synthetic `FieldPath`** within the existing `PendingChange` model (no schema change to the pending table). Path encodes script + property (+ list index / struct path). `PluginWriter` routes VMAD field paths to a dedicated apply path. See 13.4.
- **Object-type property FormKeys are tracked in `form_references` now** (not deferred) — VMAD Object/ArrayOfObject properties appear in the Phase 11 "Referenced By" tab. See 13.1.
- **Conflict detection is first-class, not deferred.** 13.2 emits an aligned diff structure mirroring `FieldDiff` (per-plugin `Values` + `CellStates`) and a `VmadConflictClassifier` computes per-cell `ConflictThis` and folds VMAD differences into the record's `ConflictAll` — so a record differing *only* in VMAD still shows in the Phase 9.6 conflict filter/tree. Struct conflicts are classified at member level (Phase 9.8 parity). The wire format is therefore an aligned `vmad: VmadCompare` structure, **not** independent per-plugin trees. See 13.2.
- **VMAD follows the unified tree model (ADR-0019)** in the compare grid — scripts and properties are sub-rows aligned across plugin columns, not per-cell widgets. Array and struct values expand into element/member sub-rows.
- **Struct/ArrayOfStruct stored as JSON is compatible with granular conflict detection** — the classifier runs on the deserialized member tree, not the raw JSON blob, so struct members are aligned and conflict-colored individually. JSON is a storage choice only; it does not flatten comparison.

---

## Out of Scope (Future)

- **ScriptFragments** (PERK, PACK, QUST, SCEN, INFO variant VMAD sections) — read or write.
- **Variable / ArrayOfVariable value editing** — no payload exists; parity with xEdit means display-only.
- **Querying into struct internals via SQL** — structs are opaque JSON in the index.

---

## Proof

*Each sub-phase carries its own Proof. This page is the index only.*
