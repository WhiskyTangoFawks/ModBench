# Manual Test

Start backend, build extension if needed, launch VS Code Extension Development Host. Do all steps proactively without waiting to be asked.

## 1 — Start the backend

```bash
cd MEditService/MEditService.Api && dotnet run -- \
  --data-folder "/home/wayne/.steam/debian-installation/steamapps/common/Fallout 4/Data" \
  --plugins-txt "/home/wayne/.steam/debian-installation/steamapps/compatdata/377160/pfx/drive_c/users/steamuser/AppData/Local/Fallout4/Plugins.txt" &
```

Poll `GET /health` until 200 before continuing.

Implicit plugins (Fallout4.esm + all DLCs) loaded via `Implicits.Get(gameRelease)` regardless of Plugins.txt — no synthetic file needed.

## 2 — Build extension (if needed)

```bash
cd medit-vscode && npm run build
```

## 3 — Launch VS Code Extension Development Host

```bash
code --extensionDevelopmentPath="/home/wayne/Games/FO4/mEdit/medit-vscode" \
     "/home/wayne/Games/FO4/mEdit" &
```

Extension attaches to running backend; session wizard auto-fires on attach.
