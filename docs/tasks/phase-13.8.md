# Phase 13.8 — VMAD Structural Editing

**Status: Not Started** · Parent: [phase-13](phase-13.md) · Depends on: 13.5 · **Model: Opus** *(largest surface area + open design decisions: change-type model, last-script removal, pending-add/value-edit merge, xEdit parity)*

*Goal: TES5Edit-parity structural operations on VMAD — add/remove a property on a script, add/remove a whole script (including attaching a script to a record that has none), change a property's type, and edit script/property flags.*

xEdit allows all of these (`wbCanAddScriptProperties`, sorted Scripts/Properties arrays, `wbScriptPropertyTypeAfterSet` for type changes). This subphase closes the gap to parity. Full stack.

---

## Operations & change types

These are not plain value edits — they add/remove tree nodes or change a property's type (which changes its value shape). Introduce VMAD-specific change semantics rather than overloading `field_edit`.

- [ ] Define VMAD structural change types (constants in `PendingChangeConstants`), e.g. `vmad_add_property`, `vmad_remove_property`, `vmad_add_script`, `vmad_remove_script`, `vmad_set_type`, `vmad_set_flags`. Decide whether to model these as distinct `ChangeType`s or as a single `vmad_struct_op` with an operation discriminator in the payload — pick one and document it. (A single op type with a JSON-encoded operation keeps `PendingChange` plumbing simple; distinct types make grouping/validation more explicit. Recommend: single `vmad_struct_op` with `{ op, ... }` payload.)
- [ ] Field path still identifies the target: `VMAD\<ScriptName>` for script-level ops, `VMAD\<ScriptName>\<PropertyName>` for property-level ops.

### Operation payloads

- **Add property**: `{ op: "add_property", type, name, flags, value }` — value per the type's payload shape (13.4/13.6/13.7). New property must keep the script's Properties array sorted by name on write.
- **Remove property**: `{ op: "remove_property" }`.
- **Add script**: `{ op: "add_script", name, flags, properties: [] }` — attaches a VirtualMachineAdapter to the record if absent (create the adapter with correct Version/ObjectFormat defaults — verify FO4 defaults, ObjectFormat 2).
- **Remove script**: `{ op: "remove_script" }`.
- **Change property type**: `{ op: "set_type", type }` — replaces the property with a new property of the target type and a default value for that type (mirror `wbScriptPropertyTypeAfterSet` behavior: changing type resets the value).
- **Set flags**: `{ op: "set_flags", flags }` for property (Edited/Removed) or script (Local/Inherited/Removed/Inherited and Removed).

## Backend apply — `PluginWriter`

- [ ] Add a `vmad_struct_op` branch alongside `ApplyVmadField`. Resolve/create the `VirtualMachineAdapter`, find/create/remove the `ScriptEntry` or `ScriptProperty`, and apply the op.
- [ ] Maintain sort order: Scripts sorted by `ScriptName`, Properties sorted by `propertyName` (xEdit stores them sorted; match so diffs stay stable).
- [ ] Removing the last script: decide whether to leave an empty adapter or null out `VirtualMachineAdapter`. Match xEdit behavior (verify) — likely keep the adapter with an empty Scripts list unless the record had none originally.
- [ ] `set_type` constructs the new concrete `Script*Property` with a type-appropriate default and preserves `Name`/`Flags`.
- [ ] Adding/removing Object properties updates `form_references`.

## Frontend

- [ ] Script row: in edit mode, "Add property" control (opens a small dialog — reuse `NewStructElementDialog` pattern — to pick name + type + initial value) and "Remove script" control.
- [ ] Section level: "Add script" control (name + flags).
- [ ] Property row: "Remove property" control; a type dropdown to change type (warns that the value resets); flags control.
- [ ] Each control stages the corresponding `vmad_struct_op` pending change. Pending display marks added/removed/retyped rows distinctly (added = new row in pending column, removed = struck-through / marked).
- [ ] Revert removes the structural pending change.

> Interaction with value edits: a script/property that is pending-added can also have pending value edits. Decide ordering/merge (simplest: a pending-added property carries its full value in the add op; subsequent value tweaks update that same pending op rather than creating a separate `field_edit`). Document the chosen rule.

---

## Tests

Backend (`dotnet test`):
- [ ] Add a property to an existing script → written plugin has the new property, array stays sorted.
- [ ] Remove a property → gone from written plugin.
- [ ] Add a script to a record with no VMAD → adapter created, script present, ObjectFormat correct.
- [ ] Remove a script → gone; remaining scripts intact.
- [ ] Change a property's type → written property has new type + default value.
- [ ] Set script/property flags → written flags match.
- [ ] Add/remove Object property updates `form_references`.

Frontend (`npm run test:unit`):
- [ ] Add-property dialog stages a `vmad_struct_op` add with the chosen type/value.
- [ ] Remove-property / add-script / remove-script controls stage the right ops.
- [ ] Type-change control stages `set_type` and reflects the reset value.
- [ ] Revert clears a structural pending change.

---

## Proof

*To be filled in on completion. Paste `dotnet test` + `npm run test:unit` output and commit hash.*
