# Mod management and editing are one tool

MO2 and xEdit are two programs: MO2 deploys a virtual `Data/` and launches xEdit inside it, and xEdit works on a snapshot until it exits. Modbench is one tool. Mod management and editing talk to each other, so reordering, enabling or disabling a mod is reflected in the Plugins tree and the record editor as it happens, with nothing relaunched and nothing reloaded.

## Strategic invariants

1. **Modbench never depends on the mod manager's runtime.** It reconstructs the instance's effective view from the physical mod folders plus the load order, the same merge deployment performs, and edits the files in place. The mod manager and Modbench coexist at the filesystem level, not the process level, and the mod manager need not be running.
2. **The extension owns the editing backend.** It spawns it, restarts it on a crash and stops it with the extension, so the backend runs for the extension's whole lifetime. No view has a mode for its absence: a disconnect is a status the client reports and the views surface as an error. Nothing outside the client names the process, the port or the health check.
3. **The plugins and the active plugins flow from Mod Management to Editing as state**, sent whenever anything that feeds them changes and reconciled, never reloaded ([ADR-0013](0013-mod-management-hands-editing-the-load-order.md)). That is what makes a mod change visible in the editor at once.
4. **Deploy is for the game, never for editing.** Editing reads the physical folders.

## Alternatives rejected

- **A user-launched backend inside usVFS, with the extension only connecting.** The user added the backend to MO2's Tools list so it saw MO2's merged `Data/`, and VS Code attached to it. It made Modbench a second program MO2 launches, and the one reason for it, the VFS, stopped applying once the extension reconstructed the view from physical paths. Its connection-first-with-managed-fallback variant made a silently spawned VFS-less process a footgun for MO2 users.
- **MO2 IPC.** Limited, version-dependent, undocumented.
