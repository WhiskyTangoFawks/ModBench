# Manual Test

Start the backend, build the extension if needed, and launch the VS Code Extension Development Host. Do all steps without waiting to be asked.

## 1 — Start the backend

```bash
cd MEditService/MEditService.Api && dotnet run -- \
  --data-folder "/home/wayne/.steam/debian-installation/steamapps/common/Fallout 4/Data" \
  --plugins-txt "/home/wayne/.steam/debian-installation/steamapps/compatdata/377160/pfx/drive_c/users/steamuser/AppData/Local/Fallout4/Plugins.txt" &
```

Poll `GET /health` until it returns 200 before continuing.

Implicit plugins (Fallout4.esm + all DLCs) are loaded automatically via `Implicits.Get(gameRelease)` regardless of Plugins.txt contents — no synthetic file needed.

Vanilla paths:
- **Data folder:** `/home/wayne/.steam/debian-installation/steamapps/common/Fallout 4/Data`
- **Plugins.txt:** `/home/wayne/.steam/debian-installation/steamapps/compatdata/377160/pfx/drive_c/users/steamuser/AppData/Local/Fallout4/Plugins.txt`

## 2 — Build the extension (if needed)

```bash
cd medit-vscode && npm run build
```

## 3 — Launch VS Code Extension Development Host

```bash
code --extensionDevelopmentPath="/home/wayne/Games/FO4/mEdit/medit-vscode" \
     "/home/wayne/Games/FO4/mEdit" &
```

The extension attaches to the already-running backend (attached mode). The session wizard should auto-fire on attach.
