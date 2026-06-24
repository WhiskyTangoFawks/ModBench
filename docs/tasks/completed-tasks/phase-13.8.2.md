# Phase 13.8.2 — VMAD Add/Remove Script

**Status: Complete** · Parent: [phase-13.8](phase-13.8.md) · Depends on: 13.8.1 · **Model: Opus**

*Goal: Add a whole script to a record (including attaching a VirtualMachineAdapter to a record that has none) and remove a script. Reuses the `vmad_struct_op` foundation from 13.8.1.*

See [phase-13.8.md](phase-13.8.md) for shared decisions and op-payload shapes.

---

## Backend

- [ ] `ApplyVmadStructOp` `add_script`: if `record.VirtualMachineAdapter` is null, create one (`Version=6`, `ObjectFormat=2`); add a `ScriptEntry { Name, Flags }` with empty/seeded properties; sort `Scripts` by name.
- [ ] `ApplyVmadStructOp` `remove_script`: remove the matching `ScriptEntry`; if it was the last, leave the adapter with an empty `Scripts` list (don't null it).
- [ ] Script-level path = prefix-stripped script name (not `TryParse`).
- [ ] `StageVmadStructOp`: `add_script` onto a no-VMAD record must be allowed (don't require an existing adapter). Extract form-refs from Object properties seeded in `add_script.properties`.

## Frontend

- [ ] Section-level "Add script" control (name + flags) → `{ op: 'add_script', name, flags, properties: [] }`.
- [ ] Per-script "Remove script" control → `{ op: 'remove_script' }`.
- [ ] Pending added-script / removed-script rendering.

---

## Tests

Backend (`dotnet test`):
- [ ] add_script to a record with no VMAD → adapter created, ObjectFormat 2, script present.
- [ ] remove_script → gone; remaining scripts intact.
- [ ] remove last script → adapter retained with empty Scripts.

Frontend (`npm run test:unit`):
- [ ] Add-script control stages `add_script`.
- [ ] Remove-script control stages `remove_script`.

---

## Proof

Commit `c39646c`. Backend `dotnet test`: 692 passed (incl. add_script no-VMAD/sorted, remove_script, remove-last-script-retains-empty-adapter). Frontend `npm run test:unit`: 257 passed; integration + build green.
