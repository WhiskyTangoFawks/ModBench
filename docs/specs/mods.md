# Mods (Loadout) — Surface Specification

**Status: Implemented.** Living spec for the Loadout surface — the Mod Management
context's primary view (Modbench-3/4/6 shipped; Modbench-9 plugin load order planned,
see [plugins.md](plugins.md)).

Mod Management context — operates on mods and files, never on records or FormKeys. The
mEdit-context vocabulary ("record", "FormKey") is absent here by construction
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary:
[modmanager CONTEXT.md](../../modbench/src/modmanager/CONTEXT.md)).

Architecture is fixed by four ADRs:

- [ADR-0021](../adr/0021-mod-manager-in-extension.md) — the mod manager lives in the
  extension, not the backend.
- [ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md) — the extension owns the
  editing backend's lifecycle; MO2 compatibility is by file import, not VFS.
- [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md) — MO2's
  Mods/Plugins/Downloads panels map to native VS Code views and editor tabs, not a
  custom panel switcher.
- [MM ADR-0001](../../modbench/src/modmanager/docs/adr/0001-mo2-native-modlist-format.md)
  — the modlist format **is** MO2's format, behind a source adapter.

Sibling surfaces: Editing ([medit.md](medit.md)); the planned Downloads tab
([downloads.md](downloads.md)); the planned Plugins load-order tree
([plugins.md](plugins.md)).

## Problem Statement

A mod author wants to build, order, enable, and run a Bethesda-game mod loadout without
leaving their editor and without committing to a single mod manager's walled garden.
Existing managers either hook the running game with a fragile, Windows-only virtual
filesystem (MO2's USVFS) or copy files around with bespoke undo logs — and none of them
sit next to a record editor. A user who already has an MO2 instance wants to keep working
on *that* instance — the same `mods/` folders, the same `modlist.txt`, the same profiles —
and have MO2 and the new tool coexist at the filesystem level instead of fighting over it.
Above all, they want the game to actually launch with their mods applied, without admin
rights, kernel features, or a mount lifecycle that fails in ways nobody can diagnose.

## Solution

The **Loadout view** — a VS Code sidebar tree ("Mods") that installs, orders, enables,
and deploys mods for the active profile. The open VS Code workspace root *is* the MO2
instance directory, so `mods/`, `profiles/`, and `ModOrganizer.ini` are read in place and
the on-disk format *is* MO2's — Modbench and MO2 can alternate on the same instance with
no divergence, and there is no separate instance-path configuration.

Deploying (letting the *game* run) and editing (inspecting/modifying *records*) are
decoupled operations against the same physical files: deploy hardlinks the enabled mods
into the game directory's `Data/`, while editing loads plugins by physical path and writes
them in place — neither operation needs the other. Because a record edit writes straight
to the source mod file (which the hardlink shares by inode anyway), an external manager
like MO2 can remain the deployer while Modbench only edits, with no process handoff and no
VFS. The sidebar switches between this Mods view and the mEdit views; **editing never
requires a deploy.**

## User Stories

1. As a mod author, I want to open my existing MO2 instance folder as my workspace and see
   my mods immediately, so that I don't have to import, convert, or re-point anything.
2. As a user, I want Modbench to read `mods/`, `profiles/`, and `ModOrganizer.ini`
   relative to the workspace root, so that there's no separate "instance path" to keep in
   sync.
3. As a user, I want the mod list grouped by the separators I already use in MO2, so that
   my organizational structure carries over intact.
4. As a user, I want mods that sit before the first separator to appear at the top of the
   list as ungrouped items, so that the tree mirrors `modlist.txt` without inventing a
   synthetic container.
5. As a user, I want a count node at the top showing how many mods are active out of how
   many are installed, so that I can gauge my loadout at a glance.
6. As a user, I want each mod shown with its name and its version from `meta.ini`, so that
   I can tell what I have installed and how current it is.
7. As a user, I want a checkbox on each mod that enables or disables it and writes
   `modlist.txt` immediately, so that toggling a mod takes effect with no separate save
   step.
8. As a user, I want to drag a mod to a new position and have its priority written to
   `modlist.txt` right away, so that manual sorting is direct manipulation.
9. As a user, I want dragging a separator to move it together with all the mods under it as
   a block, preserving their relative order, so that I can reorganize whole sections at
   once.
10. As a user, I want a filter box that narrows the list to mods (and separators) whose
    name matches what I type, so that I can find a mod without scrolling a 300-entry list.
11. As a user, I want a toggle beside the filter that controls separator behavior — keep
    matching sections in context, or collapse to a flat list of matches — so that I can
    search either structurally or flatly.
12. As a user, I want a status overlay on each mod's icon flagging file conflicts, missing
    masters, or a missing mod folder, so that I can spot problems without opening anything.
13. As a user, I want to hover a mod and see a tooltip listing the conflicting files and
    which mod wins each, so that I can understand a conflict badge in place.
14. As a user, I want to right-click a mod to open its folder in my OS file manager, so
    that I can inspect the real files behind it.
15. As a user, I want to add a separator below a mod, move a mod into a chosen separator,
    or uninstall a mod, all from its context menu, so that reorganizing is a direct action.
16. As a user, I want "View on Nexus" on a mod that has a Nexus id in its `meta.ini`, so
    that I can open its page to read about it or check for updates.
17. As a user, I want to rename, add-below, or delete a separator from its context menu,
    with a deleted separator's mods becoming ungrouped rather than lost, so that section
    management is safe.
18. As a user, I want to install a mod from a `.zip`/`.7z`/`.rar` archive or from a folder,
    so that I can add mods I've downloaded manually.
19. As a user, I want a newly installed mod to land disabled at the bottom of the list, so
    that installing never silently changes what my game loads until I enable it.
20. As a user, I want a FOMOD (scripted) installer to be detected and flagged for manual
    setup rather than run blindly, so that I'm not surprised by a half-configured install.
21. As a user in standalone mode, I want a Deploy button that makes my enabled mods
    available to the game, and a Purge button that cleanly removes them, so that I can run
    the game with my loadout and then restore a clean game directory.
22. As a user, I want deploy to never overwrite vanilla game files, so that deploying can't
    corrupt my base install.
23. As a user, I want purge to preserve files the game or tools wrote into `Data/` that
    aren't mine (F4SE output, MCM INI writes) by moving them aside rather than deleting
    them, so that I don't lose generated data.
24. As a user, I want a Launch Game action that deploys, runs the game, and purges on exit,
    so that a single action gives me a clean run-and-restore cycle.
25. As a user whose mods and game are on different volumes, I want Modbench to detect that
    at first deploy and offer a fix (move the staging folder, use a stock game folder, or
    fall back to symlinks) rather than failing cryptically, so that the constraint is
    surfaced, not hit blindly.
26. As a user who lets MO2 or Vortex own deployment, I want Modbench to hide Deploy/Purge/
    Launch entirely and only edit files in place, so that the two tools don't both try to
    be the deployer.
27. As a user, I want to keep a "stock game folder" — a vanilla copy outside Steam — and
    deploy into that, so that Steam updates and permissions can't clobber my deployed
    `Data/`.
28. As a user, I want the game directory resolved automatically (from config, then
    `ModOrganizer.ini`, then a Steam library scan) so that I usually don't have to
    configure where the game lives.
29. As a user with multiple MO2 profiles, I want to switch the active profile from the
    Mods view, have the choice persisted to `ModOrganizer.ini`, and have the tree reload,
    so that I can work on different loadouts.
30. As a user, I want switching profiles to be a clean session boundary that tears down any
    running editing session, so that the editor never shows records from the wrong
    loadout.
31. As a user, I want every write Modbench makes to `modlist.txt` and `ModOrganizer.ini` to
    change only the bytes that need changing, so that my comments, CRLF line endings,
    unmanaged (`*`) lines, and separators survive verbatim and MO2 still reads the files.
32. As a user, I want a "Launch mEdit" action in the Loadout header that switches to the
    editing views and spins up the record editor against my active loadout, so that I can
    move from managing mods to editing records without a manual setup step.
33. As a user, I want an "update available" indicator on mods (planned) once Nexus
    integration lands, so that I can tell when an installed mod is behind its Nexus
    version.

## Implementation Decisions

### Scope

- This spec covers the **Loadout surface**: the Mods tree, install, conflict/status
  badges, deploy/purge/launch, the modlist source-adapter model, profile switching, and
  the editing-backend lifecycle hook this surface owns.
- The mod manager is a subsystem of the VS Code extension (`modbench/src/modmanager/`). It
  is file/HTTP/JSON work and **never parses plugin binaries** beyond the tiny TES4-header
  master read; the C# backend stays a pure Mutagen + DuckDB record-editing service
  ([ADR-0021](../adr/0021-mod-manager-in-extension.md)).
- The **Plugin load-order** tree is a *separate* Mod-Management surface, specified in
  [plugins.md](plugins.md) — not a mode of this view.

### Instance & workspace model

- **The open VS Code workspace root is the MO2 instance directory.** `mods/`, `profiles/`,
  and `ModOrganizer.ini` are read relative to it; there is no separate instance-path
  config.
- Modbench edits mod files in place and MO2 deploys them on its next run, so the two
  **coexist at the filesystem level** — no process handoff, no VFS
  ([ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md)).

### Editing vs deploying — the central decoupling

Two independent operations against the same physical mod files:

- **Deploy (Build)** exists to let the *game* run. It hardlinks enabled mods' files into
  the game directory's `Data/`. It never needs an editing session.
- **Edit** exists to inspect/modify *records*. The backend loads plugins by physical path
  (`load-explicit`) and writes them in place, reading vanilla masters from the game
  directory. It never needs a deployed `Data/`.

Because edits write to the physical mod file directly — which a hardlink in `Data/` would
share by inode anyway — record edits go straight to the source mod file with no sync step.

### Game directory & stock game folder

- The **game directory** is where Modbench reads vanilla masters from and (standalone)
  deploys into. Resolved from `modbench.mods.gameDirectory`, falling back to
  `ModOrganizer.ini`'s `gamePath`, then Steam auto-detect (`libraryfolders.vdf` on Linux,
  registry on Windows).
- A **stock game folder** is a vanilla copy kept outside Steam's management (the Wabbajack
  pattern): it pins a known-compatible game version and keeps the real Steam install clean.
  To the deployer it is just another game directory — identical code path, different
  target. Offered for the real blockers: cross-volume hardlinks, Steam-dir write
  permissions, or Steam update/verify clobbering a deployed `Data/`.

### Deployment model: hardlinks

- Standalone deploy (`modbench.mods.deploymentMode: "standalone"`) creates hardlinks from
  `mods/` into the game directory's `Data/`; purge removes them. The game sees real files —
  no kernel features, no admin rights, no mount lifecycle. Node provides hardlinks natively
  (`fs.link` / `fs.symlink`). A hardlink is a second directory entry pointing to the same
  inode; deleting the link in `Data/` leaves the source mod file intact.
- **External mode** (`deploymentMode: "external"`): when MO2 or Vortex owns deployment,
  Deploy/Purge/Launch Game are hidden and Modbench only edits in place.
- **Same-drive constraint**: `mods/` and the game directory must be on the same volume.
  Checked at first deploy; on violation, prompt to move the staging folder, create a stock
  game folder on the mods volume, or use the **symlink fallback** (no special permission on
  Linux; admin or Developer Mode on Windows — the user is warned).

The alternatives were considered and rejected: USVFS (complex native C++, Windows-only,
anti-cheat conflicts — Modbench reconstructs MO2's *effective* merged view from physical
folders plus load order, so it never runs inside MO2's process); Nexus Mods App's copy +
event-sourced undo (GPL-3.0 would force-GPL Modbench, and hardlinks cover the same ground
with a fraction of the infrastructure); ProjFS / fuse-overlayfs (off-by-default Windows
feature / mount-lifecycle fragility); and the redirect model (a local deploy folder with a
junction over `Data/` — fragile against Steam updates and `sResourceDataDirsFinal`'s
add-but-not-replace semantics). Tannin, who wrote USVFS for MO2, chose hardlinks for Vortex
given a clean slate — the same reasoning applies here. **Decision:** deploy directly into
the configured game directory's `Data/`.

### Modlist format & source adapters

- Modbench does not invent a modlist format — its format **is** MO2's
  ([MM ADR-0001](../../modbench/src/modmanager/docs/adr/0001-mo2-native-modlist-format.md)).
  Persistence goes through an `IModlistSource` over an in-memory modlist model.
- **MO2 adapter** (first-class): reads/writes an instance in place — `mods/<name>/`, the
  active profile's `modlist.txt` (`+`/`-` prefixes, bottom = highest priority) and
  `plugins.txt`, and per-mod `meta.ini` (Nexus id/version). Separators, categories, and
  metadata survive verbatim.
- **Native adapter** (first-class): for fresh setups; writes MO2-format instances so they
  also open in MO2. No separate format.
- **Vortex adapter** (deferred): a read-only snapshot via `vortex.deployment.json`. No
  simple text modlist exists; full management is out of scope.
- **All file writes are byte-faithful via surgical edits**, never model→re-serialization:
  only the changed bytes are spliced, so CRLF, comments, `*` unmanaged lines, separators,
  and order survive.
- **Profiles**: each profile under `profiles/` has its own `modlist.txt`/`plugins.txt`. The
  active profile comes from `ModOrganizer.ini` (`[General] selected_profile`); the user
  switches via a quick pick and the choice is persisted back. The **session boundary is the
  active profile's modlist** — switching profiles starts a new session.

### Backend lifecycle (editing integration)

The extension owns the editing backend process
([ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md)):

- **Spawn** — lazily, on **Launch mEdit** (first entry into editing mode for the active
  modlist).
- **Session** — built via the backend's `load-explicit` source: an ordered
  `{name, physicalPath}` list of the active modlist's enabled plugins plus vanilla masters.
  One backend, one session (ADR-0015).
- **Teardown** — explicit **Close mEdit**, switching profile/modlist, or closing the
  workspace. Restarted on crash; re-entering editing re-spawns and re-indexes.

### UI — the Mods tree

- **Header**: title "MODS"; description = current profile name; a first non-interactive
  count node ("N active / M installed"); title-bar icon buttons for Filter, Switch Profile,
  Launch mEdit, Collapse All, Refresh, plus Deploy and Purge in standalone mode only.
- **Structure**: ungrouped mods (before the first `modlist.txt` separator) render as
  root-level items above all separator nodes — no synthetic container. Separator nodes are
  collapsible and expanded by default.
- **Mod row**: a checkbox (enable/disable, writing the `+`/`-` prefix immediately), the
  full mod name as the label, the `meta.ini` version as the description (blank if absent), a
  generic mod icon with a status overlay (see below), and a tooltip of name · version ·
  Nexus id · archive filename.
- **Filter**: the magnifier reveals a filter input matching mod and separator names
  (case-insensitive substring). A toggle beside it controls separator behavior — **on**
  (default): sections with matches auto-expand, empty ones hide, matches show in section
  context; **off**: a flat list of matching mods, separators hidden. The toggle resets to on
  when the filter clears and is not persisted. This is the same cross-surface filter
  convention used by Downloads and the Plugin List.
- **Profile selector**: "Switch Profile" opens a quick pick of directories under
  `profiles/`; selecting one persists `selected_profile` and refreshes the tree (a new
  session boundary — any editing session tears down).
- **Context menus**: a **mod** offers Open in Explorer, Add Separator Below, Move to
  Separator (quick pick of separators + "Ungrouped", moving the mod to the end of the
  section), Uninstall (confirmation; removes `mods/<name>/` and its `modlist.txt` entry),
  and View on Nexus (only when a Nexus id is present). A **separator** offers Rename, Add
  Separator Below, and Delete Separator (its mods become ungrouped / join the prior
  separator).
- **Write behavior**: every mutation (enable/disable, drag-reorder, separator ops, Move to
  Separator) writes to `modlist.txt` immediately via the active `IModlistSource`. There is
  **no save/discard flow** in this view — unlike the Editing surface, which stages pending
  changes.

### Install (Modbench-6)

- Sources: **Install from Archive…** (`.zip`/`.7z`/`.rar`) and **Install from Folder…**;
  Nexus `nxm://` is planned (see [downloads.md](downloads.md)).
- Flow: extract to temp staging → detect root type (`Data/` subfolder vs `.esp`/meshes at
  root) and normalise → write `mods/<name>/` + `meta.ini` via the active `IModlistSource` →
  append to `modlist.txt` **disabled** → the user enables and (standalone) deploys.
- FOMOD installers are **detected and flagged for manual setup, not executed**.

### Conflict index & status badges (Modbench-3)

- A `FileConflictIndex` (a winner map of the highest-priority enabled mod per relative
  path) is built on load and rebuilt on enable/disable/reorder. BA2/BSA archives are
  ordinary entries — the game's archive loader handles them.
- Per-mod status: **no conflicts** when all its files win; **N conflicts** when N files are
  overridden by a higher-priority mod; **overrides N** when it overrides N files from
  lower-priority mods; **missing master** when a plugin depends on a master not in the load
  order (detected via a tiny TES4-header read, no Mutagen); **missing mod** when
  `modlist.txt` references a folder absent on disk; and **update available** (*planned*)
  when the Nexus version exceeds the installed `meta.ini` version.
- The hover tooltip lists the conflicting files and the winner. File-level conflicts here
  are distinct from record-level conflicts (the Editing context's `IConflictClassifier`) —
  each surfaces in its own view.

### Deploy / purge / launch (Modbench-4, standalone mode)

- **Deploy**: verify same-volume (else the stock-folder / symlink-fallback prompt);
  `fs.link` each winner into `Data/<relativePath>`, skipping existing non-manifest files
  (vanilla — never overwrite); write `mods/.medit-manifest.json` listing every link.
- **Purge**: read the manifest, delete each listed hardlink, move `Data/` files that are
  neither in the manifest nor vanilla into `mods/overwrite/` (F4SE outputs, MCM INI
  writes), then delete the manifest.
- **Launch Game**: deploys, switches the sidebar to the editing views while the game runs,
  launches the configured executable (`modbench.mods.launchCommand` template for
  Proton/Wine/F4SE loaders), and purges on exit.

### Architecture / seams

- The **`IModlistSource` adapter** over an in-memory modlist model is the primary seam:
  all persistence and byte-faithful surgical edits go through it, exercised with real MO2
  instance fixtures.
- The **`FileConflictIndex`** (pure winner-map construction from a mod set + order) and the
  **surgical text transforms** (`modlistText.ts`, `metaIni.ts`, `modOrganizerIni.ts`) are
  pure-logic seams with no `vscode` import.
- A **thin VS Code adapter** (the `TreeDataProvider`, the `TreeDragAndDropController`, and
  the command handlers) wires the model to the tree and performs the unavoidable VS Code
  calls (reveal, quick picks, deploy `fs.link`); it holds no logic beyond wiring.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — same standard as
  every surface spec here: given an instance fixture + a mutation, assert the resulting
  `modlist.txt` / `meta.ini` bytes; given a mod set + order, assert the conflict/winner
  verdicts.
- **Primary unit seams** (Vitest, `npm run test:unit`, no backend): the byte-faithful text
  transforms (`modlistText.ts`, `metaIni.ts`, `modOrganizerIni.ts`) — parse, toggle
  enable/disable, reorder, separator ops — asserted byte-faithfully; and the
  `FileConflictIndex` — winner resolution, conflict/override counts, missing-master and
  missing-mod detection.
- **Prior art**: `modlistText.test.ts`, `metaIni.test.ts`, `modOrganizerIni.test.ts`,
  `statusChecker.test.ts` — fixture-in / value-out style; real MO2 instance fixtures live
  under `modbench/src/modmanager/test/fixtures/`.
- **Reused integration seam** (`npm run test:integration`, real VS Code process): the tree
  renders from an instance; a checkbox toggle and a drag-reorder round-trip to
  `modlist.txt`; install from archive lands a disabled mod; profile switch reloads. Add any
  new command id(s) to `EXPECTED_COMMANDS` (per `modbench/CLAUDE.md`).

## Out of Scope

- **FOMOD scripted installers** (`fomod/ModuleConfig.xml`) — a significant sub-project;
  currently detected and flagged for manual setup rather than executed.
- **Full Vortex management** — only a deferred read-only snapshot via
  `vortex.deployment.json` is contemplated; no text modlist exists to manage.
- **Nexus integration** (`nxm://` install, update-available badge, endorsements) — a
  Downloads-tab concern; see [downloads.md](downloads.md).
- **Plugin load-order management** (`plugins.txt` reorder/enable, missing-master, auto-sort)
  — its own Mod-Management surface; see [plugins.md](plugins.md).
- **Per-profile isolated saves and base-game config** (`local savegames` / INI) — optional
  MO2 features, deferred.
- **Delta / overlay editing** — loading an arbitrary overriding-plugin set side-by-side
  (xEdit-like) builds on `load-explicit`; deferred.

## Further Notes

- **Open questions carried forward**: MO2 round-trip fidelity needs a corpus of real MO2
  instances so separators/categories/unmodelled constructs are proven to survive verbatim;
  the Vortex adapter awaits confirmation that `vortex.deployment.json` is stable enough to
  bother with; and the **overwrite-folder UX** — files moved to `mods/overwrite/` on purge
  need a surface to reassign or discard them.
- **Vision**: one tool handles the whole modding workflow — install → manual sort → launch
  → inspect conflicts → edit records → patch — with the sidebar switching between this Mods
  view and the mEdit views, and editing never requiring a deploy.
