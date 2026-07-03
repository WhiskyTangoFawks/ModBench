# Manual Test

Build the extension if needed, then launch a VS Code Extension Development Host pointed at
a real MO2 instance directory. Do all steps proactively without waiting to be asked.

Since [ADR-0022](../../../docs/adr/0022-extension-owns-backend-lifecycle.md), the extension
owns the editing backend's lifecycle — it spawns the bundled binary itself when the user
triggers "Launch mEdit" from the Loadout view. There is no more manual `dotnet run` step and
no `--data-folder`/`--plugins-txt` flags; the backend is driven by `load-explicit` (the active
modlist's enabled plugins + vanilla masters), not a standalone data-folder scan.

## 1 — Build the extension (if needed)

```bash
cd medit-vscode && npm run build
```

The published self-contained backend binary lives at `medit-vscode/backend/` (produced by
`npm run build:backend`, part of `vscode:prepublish`) — rebuild it only if `MEditService/`
changed.

## 2 — Launch the VS Code Extension Development Host

F5 doesn't reliably work in this environment — use the CLI directly:

```bash
code --extensionDevelopmentPath="/home/wayne/Games/FO4/mEdit/medit-vscode" \
     "<path-to-an-MO2-instance-directory>" &
```

**The workspace root must be a real MO2 instance directory** (contains `ModOrganizer.ini`,
`mods/`, `profiles/`) — per `medit-vscode/CLAUDE.md`, the mod manager reads these relative to
the workspace folder; there is no separate "instance path" setting. Do not open the mEdit
source repo itself as the workspace — it has no `ModOrganizer.ini` and the Loadout view will
have nothing to show. A known local instance: `/home/wayne/Games/FO4/LitR`.

## 3 — Activate the extension

`activationEvents` is intentionally `[]` — the extension does not auto-activate on startup
(see `src/test/integration/extension.test.ts`). The Modbench activity bar icon stays hidden
until something activates the extension and sets the `modbench.viewMode` context key, because
every contributed view has a `when` clause and none default to true.

Force activation once per session by running any Modbench command from the Command Palette,
e.g. **Modbench: Refresh Mod List**. The activity bar icon then appears (Loadout view). From
there, use **Modbench: Launch mEdit** to spawn/attach the backend and switch to the Editing
view.
