---
status: accepted (supersedes ADR-0009)
---

# Extension owns the backend lifecycle; MO2 compatibility is by file import, not VFS

Supersedes [ADR-0009](./0009-user-launched-backend.md). The extension spawns and tears down the editing backend itself, passing it an ordered set of physical plugin paths (`load-explicit`): the active modlist's enabled plugins plus the vanilla masters from the game directory. Edits are written to the mod files in place.

ADR-0009 kept the backend user-launched for one reason — so it could run inside MO2's usVFS and see MO2's merged `Data/`. That rationale no longer holds. mEdit reconstructs MO2's effective view from the physical mod folders plus load order itself (the same priority merge usVFS performs), so it never depends on MO2's runtime. MO2 compatibility therefore means **importing** an MO2 instance (read its `mods/`, `modlist.txt`, `plugins.txt`) and editing its files in place — mEdit and MO2 coexist at the filesystem level, not the process level. The launch-from-MO2-under-VFS path is dropped, which removes the need to package the backend for usVFS or wrap VS Code's launch.

## Consequences

- `BackendManager` gains spawn/teardown; the "Never spawns backend process" rule in `modbench/CLAUDE.md` is reversed.
- The backend gains a `load-explicit` session source (ordered `{name, physicalPath}` list) alongside the existing single-data-folder scan. This is also the foundation for loading an arbitrary overriding-plugin set (the "delta" comparison feature).
- Deploy (hardlinks into the game directory) is decoupled from editing — it is needed only to run the game, never to edit.
