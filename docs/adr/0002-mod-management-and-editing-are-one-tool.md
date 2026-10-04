# Mod management and editing are one tool

MO2 and xEdit are two programs: MO2 deploys a virtual `Data/` and launches xEdit inside it, and xEdit works on a snapshot until it exits. Modbench is one tool. Mod management and editing talk to each other, so reordering, enabling or disabling a mod is reflected in the Plugins tree and the record editor as it happens, with nothing relaunched and nothing reloaded.

## Consequences

- Editing never depends on the mod manager or its deployment. Modbench builds the instance's view from the mod folders and the load order, the same merge deployment performs. The mod manager need not be running, and deploy is for the game alone.
- The extension runs the editing backend for its whole lifetime. The user never launches it, and no view has a mode for its absence: one tool has no half.

## Alternatives rejected

- A user-launched backend inside usVFS, with the extension only connecting. The user added the backend to MO2's Tools list so it saw MO2's merged `Data/`, and VS Code attached to it. It made Modbench a second program MO2 launches, and the one reason for it, the VFS, stopped applying once the extension reconstructed the view from physical paths. Its connection-first-with-managed-fallback variant made a silently spawned VFS-less process a footgun for MO2 users.
- MO2 IPC. Limited, version-dependent, undocumented.
