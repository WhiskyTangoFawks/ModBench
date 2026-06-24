# Phase 13.8.3 — VMAD Change Property Type

**Status: Complete** · Parent: [phase-13.8](phase-13.8.md) · Depends on: 13.8.1 · **Model: Sonnet**

*Goal: Change a property's type, resetting its value to the new type's default and preserving Name/Flags (mirrors xEdit `wbScriptPropertyTypeAfterSet`). Reuses the `vmad_struct_op` foundation from 13.8.1.*

See [phase-13.8.md](phase-13.8.md) for shared decisions and op-payload shapes.

---

## Backend

- [ ] `ApplyVmadStructOp` `set_type`: locate the property, replace it in `script.Properties` with `BuildDefaultProperty(targetType)` carrying the same `Name` and `Flags`. Reuses 13.8.1's `BuildDefaultProperty`.

## Frontend

- [ ] Type `<select>` on a property row that warns the value will reset → `{ op: 'set_type', type }`.
- [ ] Pending row marks the retype.

---

## Tests

Backend (`dotnet test`):
- [ ] set_type → written property has the new type + that type's default value; Name/Flags preserved.

Frontend (`npm run test:unit`):
- [ ] Type-change control stages `set_type` and reflects the reset value.

---

## Proof

Commit `c39646c`. Backend `dotnet test`: set_type replaces type with default value + preserves flags. Frontend `npm run test:unit`: type dropdown stages set_type; pending retype renders `→ <Type>`.
