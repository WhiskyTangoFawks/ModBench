# Mods (Loadout) — Surface Specification

The Loadout view: the Mod Management context's primary surface. A VS Code `TreeView` (`modbench.modList`, "Mods") that installs, orders, enables, and deploys mods for the active profile. It operates on mods and files, never on records or FormKeys (see [CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [modmanager CONTEXT.md](../../medit-vscode/src/modmanager/CONTEXT.md)).

Architecture is fixed by:
- [ADR-0021](../adr/0021-mod-manager-in-extension.md) — mod manager lives in the extension, not the backend
- [ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md) — the extension owns the editing backend's lifecycle; MO2 compat is by file import, not VFS
- [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md) — MO2's Mods/Plugins/Downloads panels map to native VS Code views and editor tabs, not a custom panel switcher
- [Mod-Management ADR-0001](../../medit-vscode/src/modmanager/docs/adr/0001-mo2-native-modlist-format.md) — the modlist format **is** MO2's format, behind a source adapter

The Editing surface is specified in [medit.md](medit.md); the planned Downloads surface in [downloads.md](downloads.md); the planned Plugins (load order) surface in [plugins.md](plugins.md).

---

## Vision

One tool handles the entire modding workflow: install → manual sort → launch → inspect conflicts → edit records → patch. The sidebar switches between the **Mods** view (install/sort/enable, this spec) and the **mEdit** views (load order/edit). Deploy/purge writes the merged mod view into the game directory using hardlinks so the game can run; **editing never requires a deploy** (see "Editing vs deploying" below).

The mod manager is a subsystem of the VS Code extension (`medit-vscode/src/modmanager/`). It is file/HTTP/JSON work and never parses plugin binaries. The C# backend remains a pure Mutagen + DuckDB record-editing service.

**The open VS Code workspace root _is_ the MO2 instance directory** — `mods/`, `profiles/`, and `ModOrganizer.ini` are read relative to it; there is no separate instance-path config.

---

## Editing vs deploying — the central decoupling

These are two independent operations against the same physical mod files:

| | **Deploy** (Build) | **Edit** |
|---|---|---|
| Purpose | Let the *game* run with mods | Inspect/modify records |
| Mechanism | Hardlink enabled mods' files into the game directory's `Data/` | Backend loads plugins by **physical path** (`load-explicit`) and writes them in place |
| Needs the other? | No | No — never needs a deployed `Data/` |
| Reads vanilla masters from | n/a | the game directory |

Because edits write to the physical mod file directly (which a hardlink in `Data/` would share by inode anyway), **Modbench and an external manager like MO2 coexist at the filesystem level**: Modbench edits a mod's plugin in place, MO2 deploys it on its next run. No process handoff, no VFS.

---

## Game directory & stock game folder

The **game directory** is where Modbench reads vanilla masters from and (in standalone mode) deploys into. Configurable via `modbench.mods.gameDirectory`, falling back to `ModOrganizer.ini`'s `gamePath`, then Steam auto-detect (`GamePathDetector`: `libraryfolders.vdf` on Linux, registry on Windows).

A **stock game folder** is a copy of the vanilla game kept outside Steam's management (the Wabbajack pattern): it pins a known-compatible game version and keeps the real Steam install clean. To the deployer it is just another game directory — identical code path, different target. Offered for users who hit the real blockers: cross-volume hardlinks, Steam-dir write permissions, or Steam update/verify clobbering a deployed `Data/`.

---

## Deployment model: hardlinks (Vortex approach)

Standalone deploy (`modbench.mods.deploymentMode: "standalone"`) creates hardlinks from `mods/` into the game directory's `Data/`; purge removes them. The game sees real files — no kernel features, no admin rights, no mount lifecycle. Node provides hardlinks natively (`fs.link` / `fs.symlink`).

A hardlink is a second directory entry pointing to the same inode. No data is duplicated; deleting the link in `Data/` leaves the source mod file intact.

> **When MO2 (or Vortex) owns deployment** (`deploymentMode: "external"`), Modbench does *not* deploy — Deploy/Purge/Launch Game are hidden and the external manager remains the deployer. Modbench only edits the mod files in place.

### Why not the alternatives

- **USVFS (MO2)** — API hooking via injected DLL presenting a virtual merged view to the game process. Complex native C++, Windows-only, anti-cheat conflicts. Modbench reconstructs MO2's *effective* merged view from physical mod folders plus load order itself, so it never needs to run inside MO2's process ([ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md)).
- **Vortex's own reasoning** — Tannin wrote USVFS for MO2, then chose hardlinks for Vortex: no stable free VFS exists, VFS needs per-tool customisation, VFS errors are hard to diagnose, and hardlinks work on all platforms. The same developer, given a clean slate, chose the simpler approach.
- **Nexus Mods App** — direct copy + event-sourced undo log. GPL-3.0 (would force-GPL Modbench) and deeply coupled internals; hardlinks cover the same ground with a fraction of the infrastructure.
- **ProjFS / fuse-overlayfs** — off-by-default Windows feature / mount lifecycle fragility. Neither beats hardlinks here.
- **Redirect model (local deploy folder + junction over `Data/`)** — fragile: Bethesda reads `Data/` relative to the executable, Steam updates silently restore `Data/`, and `sResourceDataDirsFinal` can add but not replace the primary data path. The stock game folder achieves the isolation goal without a redirect. **Decision**: deploy directly into the configured game directory's `Data/`.

**Write-through behavior**: both paths share an inode, so a write through `Data/foo.esp` also modifies `mods/MyMod/foo.esp`. Desirable here — record edits go straight to the source mod file, no sync step.

**Same-drive constraint**: `mods/` and the game directory must be on the same volume. Checked at first deploy; if violated, prompt to move the staging folder, create a stock game folder on the mods volume, or use the **symlink fallback** (no special permission on Linux; admin or Developer Mode on Windows — warn the user).

---

## Modlist format & source adapters

Modbench does not invent a modlist format — its format **is** MO2's ([MM ADR-0001](../../medit-vscode/src/modmanager/docs/adr/0001-mo2-native-modlist-format.md)). Persistence goes through an `IModlistSource` over an in-memory modlist model:

| Adapter | Status | Behaviour |
|---|---|---|
| **MO2** | First-class | Read/write an instance in place: `mods/<name>/`, the active profile's `modlist.txt` (`+`/`-`, top = highest priority) and `plugins.txt`, per-mod `meta.ini` (Nexus id/version). Preserves separators/categories/metadata verbatim. |
| **Native** | First-class | Fresh setups; writes MO2-format instances so they open in MO2 too. No separate format. |
| **Vortex** | Deferred | Read-only snapshot via the `vortex.deployment.json` deployment manifest. No simple text modlist exists; full management is out of scope. |

**File writes are byte-faithful via surgical edits**, never model→re-serialization: only the changed bytes of `modlist.txt`/`ModOrganizer.ini` are spliced, so CRLF, comments, `*` unmanaged lines, separators, and order survive verbatim.

**Profiles**: each profile under `profiles/` has its own `modlist.txt`/`plugins.txt`. The active profile comes from `ModOrganizer.ini` (`[General] selected_profile`); the user switches via a quick pick, and the choice is persisted back. The **session boundary is the active profile's modlist** — switching profiles is a new session. Per-profile isolated saves and base-game config (`local savegames`/INI) are optional MO2 features, deferred.

---

## Backend lifecycle (Editing integration)

The extension owns the editing backend process ([ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md)):

- **Spawn**: lazily, on **Launch mEdit** (first entry into editing mode for the active modlist).
- **Session**: built via the backend's `load-explicit` source — an ordered `{name, physicalPath}` list of the active modlist's enabled plugins plus vanilla masters. One backend, one session (ADR-0015).
- **Teardown**: explicit **Close mEdit**, switching profile/modlist, or closing the workspace. Restarted on crash. Re-entering editing re-spawns and re-indexes.

---

## UI — Mods tree

### Header

- **Title**: "MODS"; **description**: current profile name
- **Count** (first non-interactive root node): "247 active / 312 installed"
- **Icon buttons**: Filter (magnifier), Switch Profile, Launch mEdit, Collapse All, Refresh; Deploy and Purge (standalone mode only)

### Tree structure

```
MODS — Default
│
│  [count node: 247 active / 312 installed]
│
├── [✓] Ungrouped Mod A          v1.0     ← root-level (no separator)
├── [✓] Ungrouped Mod B          v2.3
│
├── ▼ F4SE - Core & Performance           ← separator node (collapsible)
│   ├── [✓] F4SE                 v0.6.23
│   └── …
│
└── ▼ F4SE - Fixes
    └── …
```

Ungrouped mods (before the first separator in `modlist.txt`) appear as root-level items above all separator nodes — no synthetic container. Separator nodes are expanded by default. Dragging a separator moves it and all its children as a block, preserving relative order.

### Mod row anatomy

| Element | Content |
| --- | --- |
| Checkbox | Enable/disable (`checkboxState`); writes `+`/`-` prefix to `modlist.txt` immediately |
| Label | Mod name (full) |
| Description | Version from `meta.ini`; blank if absent |
| Icon | Generic mod icon with status overlay: ⚠ conflict, ✗ missing master/mod (↓ update — planned, see [downloads.md](downloads.md)) |
| Tooltip | Full mod name · version · Nexus ID · archive filename |

### Filter

Magnifier button reveals a filter input matching mod and separator names (case-insensitive substring). A toggle beside it controls separator behaviour:

- **On** (default): separators with matches auto-expand; empty separators hide; matches shown in section context.
- **Off**: flat list of matching mods; separators hidden.

The toggle resets to on when the filter clears; not persisted between sessions.

### Profile selector

"Switch Profile" opens a quick pick of directories under `profiles/`. Selecting one persists `selected_profile` in `ModOrganizer.ini` and refreshes the tree (new session boundary — editing session tears down).

### Context menus

**Mod** (`contextValue: "mod"`):

| Action | Condition | Notes |
| --- | --- | --- |
| Open in Explorer | Always | Reveals `mods/<name>/` in the file explorer |
| Add Separator Below | Always | Quick-input for name; inserts below this mod |
| Move to Separator | Always | Quick pick of separators + "Ungrouped"; moves mod to end of section |
| Uninstall | Always | Confirmation; removes `mods/<name>/` and the `modlist.txt` entry |
| View on Nexus | Nexus ID in `meta.ini` | Opens the Nexus page in browser |

**Separator** (`contextValue: "separator"`): Rename, Add Separator Below, Delete Separator (mods become ungrouped / join the prior separator).

### Write behaviour

All mutations (enable/disable, drag-reorder, separator ops, Move to Separator) write to `modlist.txt` immediately via the active `IModlistSource`. No save/discard flow in this view — unlike the Editing surface, which stages pending changes.

---

## Feature behaviour

### Install (Modbench-6)

**Sources**: "Install from Archive…" (`.zip`/`.7z`/`.rar`), "Install from Folder…"; Nexus `nxm://` is planned ([downloads.md](downloads.md)).

Flow: extract to temp staging → detect root type (`Data/` subfolder vs `.esp`/meshes at root) and normalise → write `mods/<name>/` + `meta.ini` via the active `IModlistSource` → append to `modlist.txt` disabled → user enables and (standalone) deploys. FOMOD installers are detected and flagged for manual setup, not executed.

### Conflict index & status badges (Modbench-3)

A `FileConflictIndex` (winner map: highest-priority enabled mod per relative path) is built on load and rebuilt on enable/disable/reorder. BA2/BSA files are ordinary entries — the game's archive loader handles them.

| Status | Condition |
|---|---|
| No conflicts | All this mod's files are winners |
| ⚠ N conflicts | N files overridden by a higher-priority mod |
| ⚠ Overrides N | Overrides N files from lower-priority mods |
| ✗ Missing master | A plugin depends on a master not in the load order (via `MasterReader` — tiny TES4-header read, no Mutagen) |
| ✗ Missing mod | `modlist.txt` references a folder absent on disk |
| ↓ Update available | *Planned* — Nexus version > installed (`meta.ini`) |

Hover tooltip lists the conflicting files and the winner. File-level conflicts (here) are distinct from record-level conflicts (`IConflictClassifier`, Editing context) — each surfaces in its own view.

### Deploy / purge (Modbench-4, standalone mode)

**Deploy**: verify same-volume (else stock-folder / symlink fallback prompt); `fs.link` each winner into `Data/<relativePath>`, skipping existing non-manifest files (vanilla — never overwrite); write `mods/.medit-manifest.json` listing every link.

**Purge**: read the manifest; delete each listed hardlink; move `Data/` files not in the manifest and not vanilla → `mods/overwrite/` (F4SE outputs, MCM INI writes); delete the manifest. *(Overwrite-folder UX — reassign/discard — is an open question.)*

**Launch Game**: deploys, switches the sidebar to the editing views while the game runs, launches the configured executable (`modbench.mods.launchCommand` template for Proton/Wine/F4SE loaders), purges on exit.

### Plugin load order (planned — Modbench-9)

Specified separately in [plugins.md](plugins.md): a dedicated Mod-Management sidebar `TreeView`, stacked with the Mods tree ([ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md)) — not a mode of this view, not folded into the mEdit Plugins tree. Drag-and-drop reorder writing `plugins.txt`, dependency-only auto-sort (topological by masters), missing-master badge.

---

## Open questions

- **FOMOD installers** — `fomod/ModuleConfig.xml` scripted installers are a significant sub-project; currently flagged for manual setup.
- **MO2 round-trip fidelity** — needs a fidelity test corpus from real MO2 instances (separators/categories/unmodelled constructs must survive verbatim).
- **Vortex adapter** — confirm `vortex.deployment.json` is stable enough to bother with the read-only snapshot.
- **Overwrite folder UX** — files moved to `mods/overwrite/` on purge need a surface to reassign or discard.
- **Delta / overlay editing** — load an arbitrary overriding-plugin set side-by-side (xEdit-like). Builds on `load-explicit`; deferred.
