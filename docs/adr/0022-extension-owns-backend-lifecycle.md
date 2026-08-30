---
status: accepted
---

# Extension owns the backend lifecycle; MO2 compatibility is by file import, not VFS

The extension spawns and tears down the editing backend itself, passing it an ordered set of
physical plugin paths (`load-explicit`): the active modlist's enabled plugins plus the vanilla
masters from the game directory. Edits are written to the mod files in place.

Modbench reconstructs MO2's effective view from the physical mod folders plus load order itself
(the same priority merge usVFS performs), so it never depends on MO2's runtime. MO2 compatibility
therefore means **importing** an MO2 instance (read its `mods/`, `modlist.txt`, `plugins.txt`) and
editing its files in place — Modbench and MO2 coexist at the filesystem level, not the process
level.

## Consequences

- `BackendManager` owns spawn/teardown: attach if a healthy backend is already listening, else
  spawn the bundled binary; crash-restart; poll `GET /health`.
- The backend's load order source is `load-explicit` (ordered `{name, physicalPath}` list), with
  each plugin's winning physical path resolved by Mod Management's `FileConflictIndex`. This is
  also the foundation for loading an arbitrary overriding-plugin set.
- Deploy (hardlinks into the game directory) is decoupled from editing — it is needed only to run
  the game, never to edit.

## Alternatives rejected

- **User-launched backend, extension only connects (2026-06 → 2026-07).** The extension never
  spawned the backend; the user added it to MO2's Tools list and started it from MO2 so it ran
  inside usVFS and saw MO2's merged `Data/`, then VS Code attached over `GET /health`. The one
  reason for it — the VFS — stopped applying once the extension reconstructed MO2's view from
  physical paths. Its "connection-first with managed fallback" variant was rejected then too:
  a silently spawned VFS-less process was a footgun for MO2 users.
- **MO2 IPC** — limited, version-dependent, undocumented.
