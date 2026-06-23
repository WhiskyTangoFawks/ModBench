# Phase 13.7 — VMAD Struct & ArrayOfStruct Editing

**Status: Complete** · Parent: [phase-13](phase-13.md) · Depends on: 13.5 · **Model: Opus** *(hardest editing subphase; recursion on both ends + the shared `VmadJson` (de)serializer lynchpin)*

*Goal: Struct (type 7) and ArrayOfStruct (type 17) VMAD properties are editable — their nested named members (and members-of-members, recursively) can be edited, added, and removed.*

This is the hardest editing subphase: a Struct is a recursive list of named members, each itself a full typed property (scalar, array, or another struct).

---

## Data model recap

From 13.1, struct values live in `struct_json` on `vmad_properties`, and 13.2 deserializes them into the per-plugin `VmadPropertyValue.Members` (Struct) / `.StructList` (ArrayOfStruct), and aligns them across plugins into `VmadPropertyDiff.Children` for display/conflict. A member is itself a `VmadPropertyValue` — same shape, recursive. Mutagen types: `ScriptStructProperty.Members` (`ExtendedList<ScriptEntry>`) and `ScriptStructListProperty.Structs`.

## Pending model

A Struct property edits as one **atomic column** (like arrays, ADR-0019): the pending value is the **entire struct sub-tree as JSON**, keyed by `VMAD\<ScriptName>\<PropertyName>`. Editing any nested member restages the whole struct value. Rationale: nested members have names but the tree has no stable external identity for partial pending changes; atomic-column keeps revert/grouping simple and consistent with arrays.

- [ ] Value payload = the serialized struct sub-tree (members, or members-per-struct for ArrayOfStruct) — the same JSON shape as `struct_json`.

## Backend apply — `PluginWriter.ApplyVmadField`

- [ ] Extend `ApplyVmadField`: for `ScriptStructProperty` / `ScriptStructListProperty`, rebuild `.Members` / `.Structs` from the JSON sub-tree. Recursively construct each member as the correct `Script*Property` concrete type (scalars, arrays, and nested structs).
- [ ] Reuse the recursive **build** helper here and the recursive **serialize** helper from 13.1 — factor a single `VmadJson` (de)serializer used by index (13.1), query (13.2), and apply (13.7) so all three agree on the shape. This shared serializer is the lynchpin of struct support; build it deliberately.
- [ ] Object members nested in structs contribute to `form_references` (recursive FormKey collection). Extend the VMAD form-ref extraction to recurse into struct members.

## Frontend

- [ ] Struct property → expandable to member sub-rows, each rendered/edited by the **same per-type dispatch** used for top-level properties (recursion: a member that is itself a struct expands further). Reuse the `VmadSection` row renderer recursively.
- [ ] ArrayOfStruct → expandable to per-struct groups (add/remove struct), each expanding to member rows.
- [ ] Add-member / remove-member controls within a struct; add/remove struct within ArrayOfStruct.
- [ ] Any nested edit recomputes and restages the whole struct value (one atomic pending change on the property). Pending display + revert operate at the property row.

> Watch recursion depth and key stability in React: give nested rows stable keys derived from the member path (`scriptName/propertyName/memberName/...`) so expand state and edit focus survive re-render.

---

## Tests

Backend (`dotnet test`):
- [ ] Saving an edited Struct member value writes the new nested value (re-read via Mutagen/`GetVmad`).
- [ ] Adding a member to a Struct writes the new member.
- [ ] ArrayOfStruct: adding a struct element writes correctly; a nested Object member updates `form_references`.
- [ ] Round-trip of an unedited struct property is byte-stable.

Frontend (`npm run test:unit`):
- [ ] A Struct property expands to editable member rows; editing a member restages the whole struct.
- [ ] A nested struct-in-struct expands recursively.
- [ ] ArrayOfStruct add/remove struct works and restages.

---

## Proof

Backend: 676 passed, 0 failed (`dotnet test -v minimal`). Frontend: 245 unit + 4 integration passed. Commit: `ec9ffcc` (mutation triage) on branch `phase-13.7-vmad-struct-editing`, merged into `main`.
