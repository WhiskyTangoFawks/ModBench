# mEdit Mod Manager — Feature Specification

A full MO2-compatible mod manager built into the VS Code extension, unified with the existing record editor.

This spec belongs to the **Mod Management** bounded context (see [CONTEXT-MAP.md](../CONTEXT-MAP.md)). Architecture is fixed by:
- [ADR-0021](adr/0021-mod-manager-in-extension.md) — mod manager lives in the extension, not the backend
- [ADR-0022](adr/0022-extension-owns-backend-lifecycle.md) — the extension owns the editing backend's lifecycle; MO2 compat is by file import, not VFS
- [Mod-Management ADR-0001](../medit-vscode/src/modmanager/docs/adr/0001-mo2-native-modlist-format.md) — medit's modlist format **is** MO2's format, behind a source adapter

---

## Vision

One tool handles the entire modding workflow: install → manual sort → launch → inspect conflicts → edit records → patch. The sidebar switches between **Mod List** (install/sort/enable) and **Plugin List** (load order/edit). Deploy/purge writes the merged mod view into the game directory using hardlinks so the game can run; **editing never requires a deploy** (see "Editing vs deploying" below).

The mod manager is a subsystem of the VS Code extension (`medit-vscode/src/modmanager/`). It is file/HTTP/JSON work and never parses plugin binaries. The C# backend remains a pure Mutagen + DuckDB record-editing service.

---

## Editing vs deploying — the central decoupling

These are two independent operations against the same physical mod files:

| | **Deploy** (Build) | **Edit** |
|---|---|---|
| Purpose | Let the *game* run with mods | Inspect/modify records |
| Mechanism | Hardlink enabled mods' files into the game directory's `Data/` | Backend loads plugins by **physical path** (`load-explicit`) and writes them in place |
| Needs the other? | No | No — never needs a deployed `Data/` |
| Reads vanilla masters from | n/a | the game directory |

Because edits write to the physical mod file directly (which a hardlink in `Data/` would share by inode anyway), **mEdit and an external manager like MO2 coexist at the filesystem level**: mEdit edits a mod's plugin in place, MO2 deploys it on its next run. No process handoff, no VFS.

---

## Game directory & stock game folder

The **game directory** is where mEdit reads vanilla masters from and (in standalone mode) deploys into. It is configurable, with autodetection as fallback:

- **Configured** via `medit.gameDirectory` — point at the Steam install *or* a stock game folder.
- **Autodetected** otherwise — `GamePathDetector` already resolves the Steam install via `libraryfolders.vdf` (Linux) / registry (Windows). This becomes the fallback when no override is set.

A **stock game folder** is a copy of the vanilla game kept outside Steam's management (the Wabbajack pattern): it pins a known-compatible game version and keeps the real Steam install clean. To the deployer it is just another game directory — identical code path, different target.

Stock-folder setup is a one-time copy of the game tree; offered as an explicit option for users who hit the real blockers (cross-volume hardlinks, Steam-dir write permissions, or Steam update/verify clobbering a deployed `Data/`).

---

## Deployment Model: Hardlinks (Vortex approach)

Standalone deploy creates hardlinks from `mods/` into the game directory's `Data/`; purge removes them. The game sees real files — no kernel features, no admin rights, no mount lifecycle. **Node provides hardlinks natively (`fs.link` / `fs.symlink`)** — no P/Invoke.

A hardlink is a second directory entry pointing to the same inode. No data is duplicated. Deleting the link in `Data/` leaves the source mod file intact. The source mod file is the single copy; `Data/` entries are pointers to it.

> **When MO2 (or Vortex) owns deployment**, mEdit does *not* deploy — its deployer UI is hidden and the external manager remains the deployer. mEdit only edits the mod files in place.

### How MO2 does it: USVFS

MO2 uses **USVFS** (User Space Virtual File System) — API hooking. A native DLL injected into the game process intercepts Windows file I/O, presenting a virtual merged view of all mod folders to that process only; nothing is written to `Data/`. Mods toggle instantly with no redeploy. USVFS is complex native C++, Windows-only, conflicts with some anti-cheat, and is sensitive to Windows API changes.

**Why mEdit does not run inside USVFS:** mEdit reconstructs MO2's *effective* merged view from the physical mod folders plus load order itself — the same priority merge USVFS performs. So it never needs to run inside MO2's process. See [ADR-0022](adr/0022-extension-owns-backend-lifecycle.md).

### How Vortex does it: hardlinks

**Tannin** wrote USVFS for MO2, then chose **not** to use a VFS for Vortex. His published reasons:

> - There is no stable high-quality VFS with a free-to-use licence
> - VFS methods require extensive customisation per tool whereas hard links are supported natively
> - Diagnosing errors in VFS deployment is considerably more difficult
> - USVFS is Windows-only whereas hard links are supported on all platforms

Vortex deploys by hardlinking from a staging folder into `Data/`, tracked by a manifest; purge deletes the hardlinks. The same developer, given a clean slate, chose the simpler approach — that carries weight.

### How the Nexus Mods App does it: direct copy + event sourcing

NMA (Nexus's C# tool) copies files directly into the game folder and gets reversibility from an event-sourced undo log. More durable than hardlinks (no same-drive constraint) but requires substantial infrastructure. Not reusable for mEdit: **GPL-3.0** (would force-GPL mEdit) and the deployment/undo pipeline is deeply coupled to NMA internals — no standalone library. The hardlink approach covers the same ground with a fraction of the infrastructure.

### Why not ProjFS / fuse-overlayfs?

ProjFS requires an off-by-default Windows feature, kernel-callback complexity, Windows-only. fuse-overlayfs introduces a mount lifecycle (dangling mounts on crash) that hardlinks avoid. Neither beats hardlinks here.

**Write-through behavior**: both paths share an inode, so a write through `Data/foo.esp` also modifies `mods/MyMod/foo.esp`. For the mEdit use case this is *desirable* — record edits go straight to the source mod file, no sync step.

**Same-drive constraint**: `mods/` and the game directory must be on the same volume. Checked at first deploy; if violated, prompt to move the staging folder, create a stock game folder on the mods volume, or use the symlink fallback.

### Why not deploy to a local folder instead of the game's `Data/`?

A redirect model (local deploy folder + junction over `Data/`) is fragile: Bethesda reads `Data/` relative to the executable with no launch argument to change it, a Steam update silently restores `Data/` breaking the junction, and `sResourceDataDirsFinal` can add but not replace the primary data path. The **stock game folder** achieves the same isolation goal without a redirect — you launch the stock copy's own executable, so `Data/` resolves naturally. **Decision**: deploy directly into the configured game directory's `Data/` (Steam install or stock folder).

### Hardlinks vs. symlinks

Hardlinks are the primary mechanism: same semantics, no elevation, no Developer Mode, any Windows account. Symlinks (`fs.symlink`) are the explicit fallback only when `mods/` and the game directory are on different volumes — on Linux no special permission; on Windows they require admin or Developer Mode (warn the user).

---

## Modlist format & source adapters

medit does not invent a modlist format — its format **is** MO2's (see [MM ADR-0001](../medit-vscode/src/modmanager/docs/adr/0001-mo2-native-modlist-format.md)). Persistence goes through an `IModlistSource` over an in-memory modlist model:

| Adapter | Status | Behaviour |
|---|---|---|
| **MO2** | First-class | Read/write an instance in place: `mods/<name>/`, the active profile's `modlist.txt` (`+`/`-`, top = highest priority) and `plugins.txt`, per-mod `meta.ini` (Nexus id/version). Preserves separators/categories/metadata verbatim. |
| **Native** | First-class | Fresh setups; writes MO2-format instances so they open in MO2 too. No separate format. |
| **Vortex** | Deferred (afterthought) | Read-only snapshot via the `vortex.deployment.json` deployment manifest. No simple text modlist exists; full management is out of scope. |

**Profiles**: each profile under `profiles/` has its own `modlist.txt`/`plugins.txt`. The default active profile is read from `ModOrganizer.ini` (`[General] selected_profile`), but the **user selects the active profile** (MO2 presents a dropdown — VS Code mechanism is a UI-spec decision); the choice is persisted back to `selected_profile`. The **session boundary is the active profile's modlist** — switching profiles is a new session. Per-profile isolated saves and base-game config (`local savegames`/INI) are optional MO2 features, deferred.

---

## Backend lifecycle (Editing integration)

The extension owns the editing backend process ([ADR-0022](adr/0022-extension-owns-backend-lifecycle.md)). `BackendManager` gains spawn/teardown (it previously only health-polled — see the now-reversed "Never spawns backend process" rule in `medit-vscode/CLAUDE.md`).

- **Spawn**: lazily, on first entry into Plugin (editing) mode for the active modlist.
- **Warm**: the session persists for the duration of an editing session (one backend, one session — ADR-0015 preserved). Per the Modbench-5 decision, **explicit Close tears down**; re-entering editing re-spawns and re-indexes (the "warm across every view toggle" variant was not built).
- **Teardown**: on switching profile/modlist, closing the workspace, or explicit close. Restarted on crash.

The backend gains a **`load-explicit`** session source: an ordered `{name, physicalPath}` list (the active modlist's enabled plugins + vanilla masters), alongside the existing single-data-folder scan. `GameSession.AddPlugin(filePath)` already loads a plugin from an arbitrary path; `load-explicit` generalises that to construct the whole ordered session from scattered physical paths. This is also the foundation for loading an arbitrary overriding-plugin set (the future "delta" comparison feature).

---

## Architecture Overview

```
medit-vscode (extension)
  ├── modmanager/
  │   ├── ModlistSource          IModlistSource: MO2 | Native | Vortex(read) adapters
  │   ├── ModListProvider        TreeDataProvider — sidebar mod view
  │   ├── FileConflictIndex      winner[] map over enabled mods' files
  │   ├── Deployer               fs.link deploy/purge + manifest (standalone only)
  │   ├── StatusChecker          conflict/missing/dirty status per mod
  │   ├── GameDirectory          config + GamePathDetector fallback + stock-folder setup
  │   └── MasterReader           tiny TES4-header read for master lists (no Mutagen)
  ├── downloads/
  │   └── NexusDownloader        nxm:// handler, API-key downloads, extraction, staging
  ├── PluginListProvider         TreeDataProvider — plugin view (existing, extended)
  └── BackendManager             spawn/teardown editing backend; load-explicit session

MEditService (C# backend) — unchanged role: Mutagen + DuckDB record editing,
  now also accepts a load-explicit ordered physical-path session.
```

Mod data lives in a `mods/` folder per the MO2 instance layout. Each mod is `mods/<name>/` mirroring `Data/`.

---

## UI — Sidebar Views

### View Switching

Two tree views under the `medit` view container; a header toggle switches them (both registered, one visible via `when` clause):

| View | Shown when |
|---|---|
| **Mod List** | Default; managed game workspace open |
| **Plugin List** | User enters editing (Manage Load Order / open a plugin) — triggers lazy backend spawn |

### Mod List Tree

```
MODS (247 active / 312 installed)  [Deploy] [Purge]
├── [✓] Unofficial Fallout 4 Patch     v2.1.4  [no conflicts]
├── [✓] Armor Keywords Community Res…  v9.0    [⚠ 3 conflicts]
├── [✓] Sim Settlements 2              v2.2.1  [no conflicts]
├── [ ] (disabled) Old Abandoned Mod   v1.0
└── [+] Install Mod…
```

- Checkbox toggles enabled/disabled (written through the active `IModlistSource`; requires redeploy to affect `Data/`)
- Status badge: `[no conflicts]` | `[⚠ N conflicts]` | `[✗ missing master]` | `[↓ update available]`
- Drag-and-drop reordering (`TreeDragAndDropController`; requires redeploy)
- Context menu: Enable, Disable, Open Folder, Uninstall, View on Nexus
- Deploy/Purge in header (standalone mode only; hidden when an external manager owns deployment)

### Plugin List Tree

Existing tree extended with: load-order index inline, missing-master badge, drag-and-drop reordering (writes `plugins.txt`).

---

## Feature Specs

### 1. Mod Installation

**Sources:** Nexus `nxm://` (§6); "Install from Archive…" (`.zip`/`.7z`/`.rar`); "Install from Folder…".

**Flow:**
1. Extract archive to a temp staging directory (`.NET`-free: shell `7z`, or a Node archive lib)
2. Detect root type (`Data/` subfolder vs `.esp`/meshes at root) — normalise to flat mod folder
3. Write `mods/<name>/` and a `meta.ini` (Nexus id/version if known) via the active `IModlistSource`
4. Append to the profile's `modlist.txt` as disabled
5. User enables and (standalone) deploys

### 2. Enable / Disable Mods

Toggle writes the `+`/`-` prefix in `modlist.txt` and rebuilds the `FileConflictIndex` so status badges update immediately. Effective in `Data/` on next deploy.

### 3. Manual Mod Ordering

Drag-and-drop reorders the mod's line in `modlist.txt` (top = highest priority, matching MO2) and rebuilds the conflict index. Effective on next deploy.

### 4. Deploy / Purge (standalone mode)

#### Conflict Index

Built on load, rebuilt on enable/disable/reorder; the deploy manifest source:

```ts
// winner[relativePath] = absolute path in highest-priority enabled mod folder
const winner = new Map<string, string>();
for (const mod of modlist.filter(m => m.enabled))        // ascending priority
  for (const file of walk(mod.folder))
    winner.set(relativePath(file, mod.folder), file);     // later wins
```

BA2/BSA files are ordinary entries — the game's archive loader handles them.

#### Deploy

1. Verify `mods/` and the game directory are on the same volume; else offer stock-folder / symlink fallback
2. For each `winner` entry: `fs.link(source, Data/<relativePath>)`
   - Skip if `Data/<relativePath>` exists and is not a prior-deploy hardlink (vanilla file — never overwrite)
3. Write `mods/.medit-manifest.json` listing every link created

```ts
await fs.link(sourcePath, targetPath);        // hardlink, cross-platform
// fallback (different volumes): await fs.symlink(sourcePath, targetPath);
```

#### Purge

1. Read `.medit-manifest.json`
2. Delete each listed hardlink (manifest prevents touching vanilla files)
3. Move `Data/` files not in the manifest and not vanilla → `mods/overwrite/` (F4SE outputs, MCM INI writes)
4. Delete the manifest

#### Launch wiring

A "Launch Game" command (and optional VS Code task) deploys, switches the sidebar to Plugin List, launches the configured executable from the game directory, then purges on exit. (No `medit-game` debug type needed — a command suffices.)

### 5. Status Checks

Inline badges, computed by `StatusChecker` on index build:

| Status | Condition |
|---|---|
| No conflicts | All this mod's files are winners |
| ⚠ N conflicts | N of this mod's files are overridden by a higher-priority mod |
| ⚠ Overrides N | This mod overrides N files from lower-priority mods |
| ✗ Missing master | A plugin depends on a master not in the load order (via `MasterReader`) |
| ✗ Missing mod | `modlist.txt` references a folder absent on disk |
| ↓ Update available | Nexus version > installed (`meta.ini`), requires API key |

Hover tooltip lists the conflicting files and the winner. File-level conflicts (here) are distinct from record-level conflicts (`IConflictClassifier`, Editing context) — both surface in their own views.

### 6. Nexus Download Integration

`nxm://fallout4/mods/4598/files/123456` → extension registers as OS handler at install. Flow: receive URI → `DownloadManager.Enqueue` → exchange for CDN URL via Nexus API → download to `downloads/` with status-bar progress → "Install now?" → install flow (§1). API key in `vscode.SecretStorage`. Queue UI: a status-bar item (`↓ 2 downloading`) opening a quick pick.

### 7. Plugin Load Order

Plugin List view extends the existing tree: index inline; drag-and-drop reorder writes `plugins.txt`; auto-sort = topological sort by master dependencies (simplified LOOT, dependency ordering only); missing-master `✗` badge.

---

## Implementation Phases

Broken down into task files under [docs/tasks/](tasks/) as `modbench-N`. The `load-explicit` session spike (Modbench-1) goes first to de-risk the only cross-cutting unknown before any UI is built on it.

| Task | Scope | Effort |
|---|---|---|
| [**Modbench-1**](tasks/modbench-1.md) | **Spike** — `load-explicit` backend session source (ordered scattered physical paths); de-risk the session/lifecycle unknown | ~2 days |
| [**Modbench-2**](tasks/modbench-2.md) (M-1) | `GameDirectory` (config + detect + stock-folder setup); MO2 `IModlistSource` (read `mods/`, active profile `modlist.txt`/`plugins.txt`); `ModListProvider` tree; enable/disable + manual ordering writing MO2 format | ~1.5 wk |
| [**Modbench-3**](tasks/modbench-3.md) (M-2) | `FileConflictIndex`, status badges (conflict/missing), `MasterReader`, conflict hover tooltip | ~3 days |
| [**Modbench-4**](tasks/modbench-4.md) (M-3) | `Deployer`: `fs.link` deploy/purge, manifest, overwrite collection, same-volume/symlink fallback, launch wiring (standalone mode) | ~1 wk |
| [**Modbench-5**](tasks/modbench-5.md) (M-4) | Editing integration: promote `load-explicit` session; `BackendManager` spawn/teardown; Mod List ⇄ Plugin List toggle wiring the active modlist into a session | ~1 wk |
| [**Modbench-6**](tasks/modbench-6.md) (M-5) | Manual install from archive (zip/7z) writing MO2-format mod folders + `meta.ini`; FOMOD detection (flag, don't implement) | ~1 wk |
| [**Modbench-7**](tasks/modbench-7.md) (M-6) | `nxm://` handler, Nexus API download, API key storage | ~1 wk |
| [**Modbench-8**](tasks/modbench-8.md) (M-7) | Nexus version check, update-available badge | ~2 days |
| [**Modbench-9**](tasks/modbench-9.md) (M-8) | Plugin auto-sort, write `plugins.txt` | ~3 days |

**Modbench-2 → 4** is a working MO2-compatible mod manager with conflict detection and game launch, no editor coupling. **Modbench-5** unifies it with the record editor (on the spike proven in Modbench-1). No platform-specific VFS code anywhere.

---

## Open Questions

- **FOMOD installers** — `fomod/ModuleConfig.xml` scripted installers are a significant sub-project; M-5 flags FOMOD mods for manual setup.
- **MO2 round-trip fidelity** — writing `modlist.txt`/`meta.ini` must preserve unmodelled constructs (separators, categories) verbatim. Needs a fidelity test corpus from real MO2 instances.
- **Vortex** — read-only snapshot via `vortex.deployment.json` only; confirm the manifest format is stable enough to bother.
- **Archive extraction** — Node has no native 7z/RAR; shell out to `7z` or use a Node lib. Decide at M-5.
- **Nexus premium vs. free** — download-link API differs (premium gets direct CDN, free a redirect); handle both.
- **Overwrite folder UX** — files moved to `mods/overwrite/` on purge need a tree surface to reassign or discard.
- **Delta / overlay editing** — load an arbitrary overriding-plugin set side-by-side (xEdit-like). Builds on `load-explicit`; deferred until after the editor integration lands.
```
