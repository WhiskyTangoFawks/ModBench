# Phase 13.2 — VMAD Backend Query, Compare & Conflict Detection

**Status: Complete** · Parent: [phase-13](phase-13.md) · Depends on: 13.1 · **Model: Opus** *(largest read-path subphase; recursive cross-plugin alignment + conflict classification folded into record-level `ConflictAll` — the crucial integration point)*

*Goal: the read model from 13.1 is queried back, **aligned across plugins into a diff structure that mirrors `FieldDiff`**, conflict-classified (per-cell `ConflictThis` + contribution to the record's `ConflictAll`), and returned from the compare endpoint. The generated TypeScript client is updated.*

This is the largest read-path subphase: it covers query/hydration, cross-plugin alignment, and conflict classification — kept together because alignment is shared between building the diff and computing conflicts. Implement in that order; each part has its own tests.

---

## Part A — Query / hydration

- [x] Add `VmadData? GetVmad(string formKey, string plugin)` to `IRecordReader` / `DuckDbRecordRepository` (per-plugin, returns null when the plugin has no VMAD for that record). Internally: three reads (`vmad_scripts`, `vmad_properties`, `vmad_property_list_items`) + in-memory grouping by `script_name` / `property_index`, plus `struct_json` deserialization — the hydration analogue of `ScriptingAdapterHydrationService`. Avoid N+1 queries.
- [x] `VmadData` here is the **per-plugin** assembled tree (input to alignment, not the wire format):
  ```csharp
  record VmadPropertyValue(
      string Type, string Flags, object? Value, short? Alias = null,
      IReadOnlyList<VmadPropertyValue>? ListItems = null,   // scalar-array elements & ArrayOfObject
      IReadOnlyList<VmadPropertyValue>? Members = null,     // Struct members (recursive)
      IReadOnlyList<IReadOnlyList<VmadPropertyValue>>? StructList = null); // ArrayOfStruct
  record VmadScriptData(string Name, string Flags, IReadOnlyList<(string Name, VmadPropertyValue Value)> Properties);
  record VmadData(IReadOnlyList<VmadScriptData> Scripts);
  ```
  The struct/array branches deserialize from `struct_json`. Keep the serialized shape and these records aligned via the shared `VmadJson` (de)serializer from 13.1 so write/read agree.

## Part B — Alignment into a diff structure

The wire format mirrors `FieldDiff` ([Queries/Models.cs:63](../../MEditService/MEditService.Core/Queries/Models.cs#L63)) so the frontend reuses the same per-plugin cell + `CellStates` rendering:

```csharp
record VmadPropertyDiff(
    string Name,                                   // sort key = propertyName
    string Kind,                                   // "scalar"|"object"|"array"|"struct"|"structList"|"variable"
    Dictionary<string, object?> Values,            // per-plugin leaf value (scalar / "FormKey [Alias]" / null when absent or has children)
    Dictionary<string, string> Types,             // per-plugin property Type (types can differ across plugins → a conflict)
    string WinnerPlugin,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<VmadPropertyDiff>? Children);    // struct members (by name) / array elements (by index), aligned & recursive

record VmadScriptDiff(
    string Name,                                   // sort key = ScriptName
    Dictionary<string, string?> Flags,            // per-plugin script flags; null = script absent in that plugin
    string WinnerPlugin,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<VmadPropertyDiff> Properties);

record VmadCompare(IReadOnlyList<VmadScriptDiff> Scripts);
```

- [x] **Scripts** align across plugins by `ScriptName` (union of names, sorted). A plugin missing a script → null flags / absent values in that column.
- [x] **Properties** align within a script by `propertyName` (union, sorted).
- [x] **Struct members** align by member name (recursive `Children`); **scalar/object arrays** align by index. This is the same union-and-recurse pattern the generic `FieldDiff.Children` uses for struct/array sub-rows.

## Part C — Conflict classification

Mirror the generic `ConflictClassifier` ([Queries/ConflictClassifier.cs](../../MEditService/MEditService.Core/Queries/ConflictClassifier.cs)) and the Phase 9 / 9.5 / 9.7 semantics. A dedicated `VmadConflictClassifier` (or an extension of the existing one) computes:

- [x] **Winner** per script / property = the value from the winning (highest-priority) plugin that has it, consistent with how generic winners are picked.
- [x] **Per-cell `ConflictThis`** for each script row, property row, and struct-member/array-element sub-row — same enum and rules as generic cells: a plugin whose value differs from the winner is in conflict; identical-to-winner is benign; absent is its own state.
- [x] **Type conflict**: if the same property has different `Type` across plugins, that is a conflict (surface via `CellStates`; the frontend can show the differing types).
- [x] **Sorted-array awareness** (Phase 9.5): Scripts and Properties are sorted arrays — alignment by sort key already handles reordering so it is not spuriously flagged as a conflict.
- [x] **Contribution to record `ConflictAll`**: a record whose only difference is inside VMAD must still classify as conflicted, so it appears in the Phase 9.6 conflict filter / tree and conflict counts. Fold the VMAD conflict result into the record-level `ConflictAll` computed by the compare path. **This is the crucial integration point** — verify with a record that is byte-identical except for one VMAD property.

> Struct granularity: classify struct conflicts at the **member level** (recurse into `Children`), matching how Phase 9.8 did per-sub-field struct conflict — not whole-struct string compare. If member-level proves too large, a documented fallback is whole-struct value compare, but member-level is the parity target.

## Compare integration & API

- [x] Extend `CompareResult` ([Queries/Models.cs:76](../../MEditService/MEditService.Core/Queries/Models.cs#L76)) with `VmadCompare? Vmad = null` (null/absent when no plugin in the override set has VMAD). Do **not** fold VMAD into `Diffs`.
- [x] Compare endpoint already declares `.Produces<CompareResult>()`; verify the new field flows through Swashbuckle (no anonymous types).
- [x] Run `npm run generate-api` (backend live on :5172); commit regenerated [medit-vscode/src/generated/api.ts](../../medit-vscode/src/generated/api.ts) with the C# change.

---

## Tests

Query (Part A):
- [x] `GetVmad()` returns correct values for a script with a Bool and an Object property (value + alias); reconstructs a scalar-array in order; reconstructs a Struct's members from `struct_json`; returns null when no VMAD.

Alignment + conflict (Parts B/C):
- [x] Two plugins with the same script but a differing property value → that property's `CellStates` marks the non-winner as conflicted; winner is correct.
- [x] A script present in one plugin and absent in another → absent column reflected; presence difference classified.
- [x] Same property, different `Type` across plugins → classified as conflict.
- [x] Struct member differing across plugins → member sub-row conflict (member-level granularity).
- [x] **A record identical except for one VMAD property classifies as conflicted at the record level (`ConflictAll`)** and would appear in the conflict filter.
- [x] Reordered (but equal) sorted Scripts/Properties are **not** flagged as conflicts.
- [x] Compare response includes `Vmad` with correct aligned scripts; absent when no override has VMAD.

---

## Proof

Implemented TDD (red→green per behavior). Full backend suite green:

```
Passed!  - Failed: 0, Passed: 612, Skipped: 0, Total: 612 - MEditService.Tests.dll (net9.0)
```

New tests: `GetVmadTests` (8 — Bool/Object/Float/String scalars; Int + bool/float/
string/object array hydration in order; struct members + ArrayOfStruct from
`struct_json`; null when no VMAD; property order), `VmadConflictClassifierTests`
(13 — differing scalar, presence, type conflict, struct member-level, array-element,
struct-list, Object leaf value, differing script flags, uncontested-Override,
disjoint properties/members, sorted ordering, reordered-but-equal),
`RecordQueryServiceTests` (+5 — VMAD-only difference classifies as `Conflict`;
`Vmad` null when none have it; only-override-has-VMAD populates `Vmad`;
field-override + VMAD stays `Override`; field-override + VMAD conflict escalates to
`Conflict`). Frontend mechanical gates (build + unit + integration) green.

`npm run generate-api` regenerated `medit-vscode/src/generated/api.ts` (+30 lines,
purely additive): `vmad?` on `CompareResult` plus `VmadCompare` / `VmadScriptDiff`
/ `VmadPropertyDiff` schemas.

Key files: `Records/VmadData.cs` (per-plugin hydration tree, new),
`Records/DuckDbRecordRepository.cs` (`GetVmad` 3-read hydration),
`Schema/VmadJson.cs` (shared (de)serializer; `VmadIndexer` now routes through it),
`Queries/VmadConflictClassifier.cs` (alignment + per-cell `ConflictThis`, new),
`Queries/RecordQueryService.cs` (`GetCompare` folds VMAD into `ConflictAll` via
`EscalateConflict`), `Queries/Models.cs` (wire DTOs).

`/simplify` applied: `EscalateConflict` made order-independent (explicit switch,
no enum-ordinal reliance); clarifying comment on array-element flags.
`/code-review` (correctness + conventions): no bugs. Pre-existing FO4 type coupling
in `VmadIndexer.FlagsString` noted as out-of-scope (established in 13.1).

`/mutation-test`: first run surfaced 52 survivors (test gaps in correct code). Triage
killed them by adding the classifier/hydration/compare tests above; the genuine
equivalent mutants were removed by simplification rather than suppressed — `winner`
is provably non-null at every call site so `FirstOrDefault`/`?? masterPlugin`/the
dead null guard were dropped, and `VmadJson` deserialize `?? []` (unreachable, since
`struct_json` is always a serialized array) became a documented `!`.

Implementation note: struct members align by field name — the binary's single
unnamed `ScriptEntry` wrapper is flattened so struct fields surface directly
(matches member-level conflict granularity). Per-plugin `Members` made a named
`VmadNamedValue` list (refinement over the doc's nameless list) so alignment by
member name works.

Commits on branch `phase-13.2-vmad-query-compare`: `b7d7b11` (implementation +
`api.ts`) followed by the mutation-triage + completion commit (this commit).
