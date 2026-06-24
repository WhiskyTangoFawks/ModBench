# Phase 13.8.4 — VMAD Set Flags

**Status: Complete** · Parent: [phase-13.8](phase-13.8.md) · Depends on: 13.8.1 · **Model: Sonnet**

*Goal: Edit script flags (Local/Inherited/Removed/InheritedAndRemoved) and property flags (Edited/Removed). Reuses the `vmad_struct_op` foundation from 13.8.1.*

See [phase-13.8.md](phase-13.8.md) for shared decisions and op-payload shapes.

---

## Backend

- [ ] `ApplyVmadStructOp` `set_flags`: parse target flags string → `ScriptProperty.Flag` (Edited 0x01 / Removed 0x03) for property paths, or `ScriptEntry.Flag` (Local/Inherited/Removed/InheritedAndRemoved) for script paths; assign.

## Frontend

- [ ] Flags control on property and script rows → `{ op: 'set_flags', flags }`.

---

## Tests

Backend (`dotnet test`):
- [ ] set property flags → written flags match.
- [ ] set script flags → written flags match.

Frontend (`npm run test:unit`):
- [ ] Flags control stages `set_flags` with the chosen value.

---

## Proof

Commit `c39646c`. Backend `dotnet test`: set_flags writes property (ScriptProperty.Flag) and script (ScriptEntry.Flag) flags. Frontend `npm run test:unit`: script/property flags controls stage set_flags with the chosen value.
