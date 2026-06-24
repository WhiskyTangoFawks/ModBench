# Phase 13.8 — VMAD Structural Editing

**Status: Complete** · Parent: [phase-13](phase-13.md) · Depends on: 13.5 · **Model: Opus**

*Goal: TES5Edit-parity structural operations on VMAD — add/remove a property on a script, add/remove a whole script (including attaching a script to a record that has none), change a property's type, and edit script/property flags.*

Phases 13.4–13.7 made VMAD **values** editable; the tree shape stayed frozen. xEdit allows all structural ops (`wbCanAddScriptProperties`, sorted Scripts/Properties arrays, `wbScriptPropertyTypeAfterSet` for type changes). This subphase closes the gap to parity. Broken into four full-stack sub-phases developed TDD-first.

---

## Sub-phases

| Phase | Goal | Depends on | Model |
| ----- | ---- | ---------- | ----- |
| [13.8.1](phase-13.8.1.md) | **Foundation + add/remove property** — `vmad_struct_op` change type, PATCH/StageEdit threading, writer dispatch + sorted insertion, form-refs for added Object props; frontend add-property dialog + remove control + pending added/removed rendering | 13.5 | Opus |
| [13.8.2](phase-13.8.2.md) | **Add/remove script** — `add_script` (create adapter when absent, defaults 6/2), `remove_script` (keep empty adapter); section-level "Add script" + per-script "Remove script" controls | 13.8.1 | Opus |
| [13.8.3](phase-13.8.3.md) | **Change property type** — `set_type` replaces the property with a default-valued property of the target type, preserving Name/Flags; frontend type dropdown with value-reset warning | 13.8.1 | Sonnet |
| [13.8.4](phase-13.8.4.md) | **Set flags** — `set_flags` for property (Edited/Removed) and script (Local/Inherited/Removed/InheritedAndRemoved); frontend flag controls | 13.8.1 | Sonnet |

13.8.1 lands the shared `vmad_struct_op` foundation. 13.8.2/3/4 have no ordering between them once 13.8.1 lands, but they touch overlapping files (`PluginWriter`, `VmadSection.tsx`) — coordinate merges as 13.6/13.7 did.

---

## Shared decisions (apply across all sub-phases)

- **Single change type `vmad_struct_op`** (not one type per op), with a JSON op payload `{ op, ... }`. Keeps `PendingChange`/`Upsert`/save-dispatch plumbing simple; the `op` discriminator does the routing.
- **Field path:** `VMAD\<ScriptName>` for script-level ops, `VMAD\<ScriptName>\<PropertyName>` for property-level ops. `VmadPath.TryParse` rejects a missing property segment, so script-level ops parse the script name directly via the prefix rather than `TryParse`.
- **Sorted on write:** after any add, sort `script.Properties` by `Name` and `vmad.Scripts` by `Name` using the same `OrdinalIgnoreCase` comparer the lookups use. Re-sorting an already-sorted list is a no-op, so untouched records stay byte-stable.
- **Last-script removal keeps an empty adapter** (don't null `VirtualMachineAdapter`) — matches xEdit's `wbArrayS` behavior.
- **New adapter defaults** (add-script onto a record with no VMAD): `Version = 6`, `ObjectFormat = 2` — Mutagen `AVirtualMachineAdapter.VersionDefault`/`ObjectFormatDefault` and xEdit FO4 defaults.
- **set_type resets the value** to the new type's default (mirrors xEdit `wbScriptPropertyTypeAfterSet`); `Name` and `Flags` preserved.
- **Pending-add + value-edit merge:** an add op carries the property's full initial value. A later value tweak to a pending-added property **re-issues the same `add_property` op** with the updated value. Because `Upsert` keys on `(form_key, plugin, field_path)`, this overwrites the pending op in place — no separate `field_edit`, no backend merge logic. The frontend decides this by checking whether a pending `vmad_struct_op` add exists for the path.

### Operation payloads

- **Add property**: `{ op: "add_property", type, name, flags, value }` — `value` per the type's payload shape (13.4/13.6/13.7).
- **Remove property**: `{ op: "remove_property" }`.
- **Add script**: `{ op: "add_script", name, flags, properties: [] }`.
- **Remove script**: `{ op: "remove_script" }`.
- **Change property type**: `{ op: "set_type", type }`.
- **Set flags**: `{ op: "set_flags", flags }`.

---

## Proof

*Each sub-phase carries its own Proof. This page is the index only.*
