# mEdit Mod Manager — Feature Specification

A full MO2 replacement built into the VS Code extension, unified with the existing record editor.

---

## Vision

One tool handles the entire modding workflow: install → sort → launch → inspect conflicts → edit records → patch. The sidebar switches between **Mod List** (install/sort/enable) and **Plugin List** (load order/edit) depending on context. A deploy/purge step via VS Code run configuration writes the merged mod view into the game's `Data/` folder using hardlinks.

---

## Deployment Model: Hardlinks (Vortex approach)

Rather than a live VFS mount, mEdit uses the same strategy as Vortex: **deploy** creates hardlinks from `Data/` into mod staging folders; **purge** removes them. The game sees real files — no kernel features, no admin rights, no mount lifecycle.

A hardlink is a second directory entry pointing to the same inode. No data is duplicated. Deleting the link in `Data/` leaves the source mod file intact. The source mod file is the single copy of the data; `Data/` entries are just pointers to it.

### How MO2 does it: USVFS

MO2 uses **USVFS** (User Space Virtual File System) — a technique called API hooking. A native DLL is injected into the game process at launch, intercepting Windows file I/O calls (CreateFile, FindFirstFile, etc.) before they reach the kernel. The game sees a virtual merged view of all mod folders, but only that process does; nothing is written to `Data/`. Mods enabled/disabled instantly with no redeploy step.

USVFS is complex native C++, Windows-only, and not trivially reusable. The hooking approach can also conflict with anti-cheat software and is sensitive to Windows API changes.

### How Vortex does it: hardlinks

**Tannin** (Tannin42) wrote USVFS for MO2, then joined Nexus Mods as lead developer of Vortex — their official successor tool. Despite having written a working VFS himself, he explicitly chose **not** to use VFS for Vortex. His stated reasons, published in Vortex's documentation:

> - There is no stable high-quality VFS with a free-to-use licence
> - VFS methods require extensive customisation to work with different tools whereas hard links are supported natively
> - Diagnosing errors in VFS deployment is considerably more difficult
> - USVFS is Windows-only whereas hard links are supported on all platforms

Vortex deploys by creating hardlinks from a staging folder into `Data/`, tracked by a manifest. Purge deletes the hardlinks. The same developer, given a clean slate, chose the simpler approach — that carries weight.

### How the Nexus Mods App does it: direct copy + event sourcing

The Nexus Mods App (NMA) is Nexus's third-generation official tool, built in C#. It uses a fourth paradigm — no VFS, no hardlinks. Instead:

- Deployment is described as a `DeploymentData` struct: two dictionaries mapping archive source paths → game directory targets
- On "Apply," those instructions are executed by **copying files directly** into the game folder
- Reversibility comes from **event sourcing** — an undo log of every file operation, replayed to restore prior state

This is more durable than hardlinks (no same-drive constraint, no dangling links) but requires a substantial event sourcing infrastructure. Their whole deployment pipeline is built on a custom `DataModel`, `Loadout`, and undo system — none of it is published as a NuGet package, and everything is tightly coupled.

**Why not use NMA's code directly?** Two reasons:

1. **License: GPL-3.0.** Incorporating their code requires GPL-ing mEdit. Hard blocker.
2. **Not extractable.** The interesting pieces (deployment pipeline, FOMOD installer, undo log) are deeply coupled to NMA's internal infrastructure. There is no standalone library to pull in.

NMA's event sourcing model is elegant but the complexity is not justified for what mEdit needs. The hardlink approach covers the same ground with a fraction of the infrastructure.

### Why not ProjFS / fuse-overlayfs?

ProjFS (Windows Projected File System) requires an optional Windows feature that is not enabled by default, adds kernel-level callback complexity, and is Windows-only. fuse-overlayfs on Linux is closer to viable but introduces a mount lifecycle (dangling mounts on crash, teardown ordering) that hardlinks avoid entirely. Neither offers meaningful advantages over hardlinks for this use case.

**Write-through behavior**: because both paths share an inode, a write through `Data/foo.nif` also modifies `mods/MyMod/foo.nif`. For read-only assets (textures, meshes, BA2s) this is a non-issue. For the mEdit use case it is actually desirable — edits made through the record editor go directly to the source mod file, with no extra sync step.

**Same-drive constraint**: `mods/` and `Data/` must be on the same partition. Checked at first deploy; if violated, the user is prompted to move the staging folder or use the symlink fallback (requires admin on Windows).

---

## Architecture Overview

```
medit-vscode (extension)
  ├── ModListProvider          TreeDataProvider — sidebar mod view
  ├── PluginListProvider       TreeDataProvider — sidebar plugin view (existing, extended)
  ├── DownloadManager          nxm:// handler + queue UI
  └── DeployRunConfig          preLaunchTask / postDebugTask wiring

MEditService (C# backend, unified)
  ├── ModManager/
  │   ├── ModList              ordered, persisted mod registry
  │   ├── FileConflictIndex    winner[] map built from ModList
  │   ├── Deployer             hardlink create/purge + manifest
  │   ├── PluginOrderService   load order with missing-master detection
  │   └── StatusChecker        conflict/missing/dirty status per mod
  └── Downloads/
      └── NexusDownloader      API-key downloads, extraction, staging
```

Mod data lives in a `mods/` folder next to the game's `Data/` directory. Each mod occupies `mods/<name>/` as a flat folder mirroring the `Data/` layout.

---

## UI — Sidebar Views

### View Switching

The sidebar panel has two tree views registered under the `medit` view container:

| View | Shown when |
|---|---|
| **Mod List** | Default; workspace open, game not running |
| **Plugin List** | User clicks "Manage Load Order" or opens a plugin for editing |

A toggle button in the panel header switches between views. Both are always registered; only one is visible at a time (`when` clause in `package.json`).

### Mod List Tree

```
MODS (247 active / 312 installed)  [Deploy] [Purge]
├── [✓] Unofficial Fallout 4 Patch     v2.1.4  [no conflicts]
├── [✓] Armor Keywords Community Res…  v9.0    [⚠ 3 conflicts]
├── [✓] Sim Settlements 2              v2.2.1  [no conflicts]
├── [ ] (disabled) Old Abandoned Mod   v1.0    
└── [+] Install Mod…
```

- Checkbox toggles enabled/disabled (persisted to `modlist.json`; requires redeploy to take effect)
- Status badge: `[no conflicts]` | `[⚠ N conflicts]` | `[✗ missing master]` | `[↓ update available]`
- Drag-and-drop reordering (`TreeDragAndDropController`; requires redeploy)
- Context menu: Enable, Disable, Open Folder, Uninstall, View on Nexus
- Deploy/Purge buttons in tree header; also wired to run config tasks

### Plugin List Tree

Existing tree extended with:
- Load order index shown inline
- Missing master warning badge
- Drag-and-drop reordering (same controller pattern)

---

## Feature Specs

### 1. Mod Installation

**Sources:**
- Nexus Mods via `nxm://` protocol (see §6)
- Manual install: "Install from Archive…" command picks a `.zip`/`.7z`/`.rar`
- Manual folder: "Install from Folder…" copies an already-extracted directory

**Install flow:**
1. Extract archive to a temp staging directory
2. Detect root type (does it contain a `Data/` subfolder, or are `.esp`/meshes at root?) — auto-normalize to flat mod folder layout
3. Copy to `mods/<name>/`
4. Append entry to `modlist.json` as disabled
5. User enables and deploys

**modlist.json format:**
```json
{
  "mods": [
    { "name": "Unofficial Fallout 4 Patch", "folder": "unofficial_fo4_patch", "enabled": true, "priority": 0, "nexusId": 4598, "version": "2.1.4" }
  ]
}
```

Priority = position in array (index 0 = lowest, last = highest). Reorder = re-index.

---

### 2. Enable / Disable Mods

Toggle sets `enabled` in `modlist.json` and rebuilds the FileConflictIndex so status badges update immediately. Changes take effect in `Data/` on the next deploy.

---

### 3. Manual Mod Ordering

Drag-and-drop in the tree view reorders `modlist.json` and rebuilds the conflict index. Priority rule: **higher index = higher priority** (later entry wins). Matches MO2's left-panel semantics. Changes take effect in `Data/` on the next deploy.

---

### 4. Deploy / Purge

#### Conflict Index

Built once on load, rebuilt on any enable/disable/reorder. This is the deploy manifest source:

```csharp
// winner[relativePath] = absolute path in highest-priority mod folder
Dictionary<string, string> _winner = new();

foreach (var mod in modList.Where(m => m.Enabled).OrderBy(m => m.Priority))
    foreach (var file in Directory.EnumerateFiles(mod.Folder, "*", SearchOption.AllDirectories))
        _winner[RelativePath(file, mod.Folder)] = file;
```

BA2/BSA files are entries in this index like any other file — no special handling. The game's own archive loader handles extraction.

#### Deploy

1. Verify `mods/` and `Data/` are on the same volume; abort with message if not
2. For each entry in `_winner`: create a hardlink at `Data/<relativePath>` pointing to the source file
   - Skip if `Data/<relativePath>` already exists and is not a hardlink from a previous deploy (vanilla game file — do not overwrite)
3. Write `mods/.manifest.json` listing every hardlink created

```csharp
// Windows
[DllImport("kernel32.dll")]
static extern bool CreateHardLink(string lpFileName, string lpExistingFileName, IntPtr reserved);

// Linux
[DllImport("libc")]
static extern int link(string oldpath, string newpath);
```

#### Purge

1. Read `mods/.manifest.json`
2. Delete each hardlink listed (only hardlinks — manifest prevents touching vanilla files)
3. Scan `Data/` for files not in the manifest and not original game files → move to `mods/Overwrite/` (game-generated files: F4SE outputs, MCM INI writes, etc.)
4. Delete manifest

#### VS Code Run Configurations

```json
{
  "version": "2.0.0",
  "tasks": [
    { "label": "medit: Deploy",  "type": "shell", "command": "curl -X POST http://localhost:5172/deploy" },
    { "label": "medit: Purge",   "type": "shell", "command": "curl -X POST http://localhost:5172/purge" }
  ]
}
```

```json
{
  "configurations": [
    {
      "name": "Launch Fallout 4",
      "type": "medit-game",
      "request": "launch",
      "executable": "${config:medit.gameExecutable}",
      "preLaunchTask": "medit: Deploy",
      "postDebugTask": "medit: Purge"
    }
  ]
}
```

`preLaunchTask` deploys and switches the sidebar to Plugin List view. `postDebugTask` purges (collecting Overwrite files) and switches back to Mod List view.

#### Fallback: Symlinks

If `mods/` and `Data/` are on different drives, offer symlinks. On Linux these require no special permissions. On Windows they require either admin rights or Developer Mode. Warn the user and offer a "Run as Administrator" re-launch if needed. Symlinks have the same deploy/purge semantics; only the link creation call differs.

---

### 5. Status Checks

Displayed as inline badges in the mod tree. Computed by `StatusChecker` on index build.

| Status | Condition |
|---|---|
| No conflicts | Mod's files are all winners — nothing overrides them |
| ⚠ N conflicts | N of this mod's files are overridden by a higher-priority mod |
| ⚠ Overrides N | This mod overrides N files from lower-priority mods |
| ✗ Missing master | A plugin in this mod depends on a master not in the load order |
| ✗ Missing mod | `modlist.json` references a folder that doesn't exist on disk |
| ↓ Update available | Nexus version > installed version (requires Nexus API key) |

Hover tooltip on conflict badge: lists the specific files conflicting and which mod wins.

The existing `IConflictClassifier` (record-level conflicts) is distinct from this file-level conflict index — both surface in their respective views.

---

### 6. Nexus Download Integration

#### nxm:// Protocol

Nexus "Mod Manager Download" button fires `nxm://fallout4/mods/4598/files/123456`. The extension registers as the OS-level handler at install time (platform-specific, handled by the VSIX installer).

Flow:
1. nxm:// URI received → extension activates if needed → `DownloadManager.Enqueue(uri)`
2. Exchange nxm URI for a CDN URL via Nexus API (`/v1/games/{game}/mods/{modId}/files/{fileId}/download_link`)
3. Download to `downloads/` with progress in VS Code status bar notification
4. On completion: prompt "Install now?" → run install flow (§1)

Requires a Nexus API key stored in VS Code secrets (`vscode.SecretStorage`). First use prompts for the key.

#### Download Queue UI

Status bar item shows `↓ 2 downloading`. Clicking opens a quick pick with active downloads and progress. No separate panel needed.

---

### 7. Plugin Load Order

The Plugin List view extends the existing tree with load order management:

- Index number shown left of plugin name
- Drag-and-drop reorder (writes `plugins.txt`)
- Auto-sort command: topological sort by master dependencies (simplified LOOT — dependency ordering only, no rule-based sorting)
- Missing master shown as `✗` badge on the plugin entry
- "Deploy load order" writes `plugins.txt` to the game's AppData folder

---

## Implementation Phases

| Phase | Scope | Effort |
|---|---|---|
| **M-1** | modlist.json CRUD, ModListProvider tree, enable/disable, manual ordering | ~1 week |
| **M-2** | FileConflictIndex, status badges (conflict/missing), conflict hover tooltip | ~3 days |
| **M-3** | Deployer: hardlink deploy/purge, manifest, Overwrite collection, run config wiring (cross-platform) | ~1 week |
| **M-4** | Manual install from archive (zip/7z), FOMOD detection (flag, don't implement) | ~1 week |
| **M-5** | nxm:// handler, Nexus API download, API key storage | ~1 week |
| **M-6** | Nexus version check, update available badge | ~2 days |
| **M-7** | Plugin auto-sort, deploy load order to AppData | ~3 days |

M-1 through M-3 is the coherent usable slice: a working mod manager with conflict detection and game launch on both platforms, no platform-specific VFS code required.

---

## Open Questions

- **FOMOD installers** — many mods ship with `fomod/ModuleConfig.xml`. Implementing a FOMOD UI is a significant sub-project; M-4 skips it and flags FOMOD mods for manual setup.
- **Profile system** — MO2 profiles (separate modlist + plugins.txt per profile) deferred until after M-7.
- **7z/RAR extraction** — .NET has no native 7z/RAR support; use `SharpCompress` NuGet (handles most cases) or shell out to `7z`.
- **Nexus premium vs. free** — CDN download links return faster servers for premium; free accounts get a redirect. The API response differs slightly; handle both.
- **Overwrite folder UX** — files moved to `mods/Overwrite/` on purge need a UI: show them in the tree so the user can assign them to a mod or discard them.
