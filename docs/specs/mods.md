# Mods (Loadout) — Surface Specification

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
- [ADR-0021](../adr/0021-mod-manager-in-extension.md)
  — the modlist format **is** MO2's format, behind a source adapter.

Sibling surfaces: Editing ([medit.md](medit.md)); the Downloads tree
([downloads.md](downloads.md)); the Plugins load-order tree
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
VFS. The Mods view and the mEdit views are co-visible in one sidebar; **editing never
requires a deploy.**

## User Stories

1. As a mod author, I want to open my existing MO2 instance folder as my workspace and see
   my mods immediately, so that I don't have to import, convert, or re-point anything.
2. As a user, I want Modbench to read `mods/`, `profiles/`, and `ModOrganizer.ini`
   relative to the workspace root, so that there's no separate "instance path" to keep in
   sync.
3. As a user, I want the mod list grouped by the separators I already use in MO2, so that
   my organizational structure carries over intact.
4. As a user, I want mods that sit before the first separator to render as ungrouped
   root-level items (at the winning end of the list — the bottom, in the default
   losing-at-top view), so that they carry over without a synthetic container.
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
24. As a user, I want Deploy and Purge to be explicit actions, independent of launching
    anything, so that a deployed `Data/` persists across as many tool runs as I like and I
    always know which state my game directory is in.
25. As a user whose mods and game are on different volumes, I want Modbench to detect that
    at first deploy and offer a fix (move the staging folder, use a stock game folder, or
    fall back to symlinks) rather than failing cryptically, so that the constraint is
    surfaced, not hit blindly.
26. As a user who lets MO2 or Vortex own deployment, I want Modbench to hide Deploy/Purge and
    the executable tasks entirely and only edit files in place, so that the two tools don't
    both try to be the deployer.
27. As a user, I want to keep a "stock game folder" — a vanilla copy outside Steam — and
    deploy into that, so that Steam updates and permissions can't clobber my deployed
    `Data/`.
28. As a user, I want the game directory resolved automatically (from config, then
    `ModOrganizer.ini`, then a Steam library scan) so that I usually don't have to
    configure where the game lives.
29. As a user with multiple MO2 profiles, I want to switch the active profile from the
    Mods view, have the choice persisted to `ModOrganizer.ini`, and have the tree reload,
    so that I can work on different loadouts.
30. As a user, I want switching profiles to hand the new profile's load order to any running
    editing backend, so that the editor never shows records from the wrong loadout.
31. As a user, I want every write Modbench makes to `modlist.txt` and `ModOrganizer.ini` to
    change only the bytes that need changing, so that my comments, CRLF line endings,
    unmanaged (`*`) lines, and separators survive verbatim and MO2 still reads the files.
32. As a user, I want the record editor running against my active loadout the moment Modbench
    opens, so that I can move from managing mods to editing records without any launch step
    (maintainer ruling 2026-09-01 — the former "Launch mEdit" action is gone).
33. As a user, I want an "update available" indicator on mods (planned) once Nexus
    integration lands, so that I can tell when an installed mod is behind its Nexus
    version.
34. As a user, I want a title-bar toggle to flip the mod list between the default
    losing-at-top view (base/master mods on top, winning overrides at the bottom, matching
    MO2) and winning-at-top, so that I can view the list in either direction — a view-order
    choice that never changes which mod wins.
35. As a user, I want every executable I have configured in MO2 to appear as a VS Code task,
    so that I can launch the game, F4SE, a plugin editor or a generator from Modbench without
    re-declaring any of them.
36. As a user, I want MO2 to stay the source of truth for what gets launched — binary,
    arguments, working directory — so that Modbench never second-guesses whether I run the
    Steam copy or a stock folder, or the base game or a script extender.
37. As a Linux user, I want those tasks to run inside the game's existing Proton prefix, so
    that the script extender and installed redistributables are present and I don't
    hand-write a Wine invocation per tool.
38. As a Linux user with tools MO2 cannot launch — a native script, or a Windows tool needing
    a hand-rolled Wine wrapper — I want to declare them as tasks alongside the MO2 ones, so
    that my whole toolchain lives in one picker.
39. As a user, I want a task that needs a deployed `Data/` to tell me when nothing is
    deployed, rather than running against a vanilla folder, so that a plugin editor or
    generator never silently operates on the wrong data.
40. As a user, I don't want Modbench writing task configuration into my instance folder, so
    that editing executables in MO2 is enough and no generated file can go stale behind my
    back.

## Implementation Decisions

### Scope

- This spec covers the **Loadout surface**: the Mods tree, install, conflict/status
  badges, deploy/purge, launching executables as tasks, the modlist source-adapter model,
  profile switching, and the editing-backend lifecycle hook this surface owns.
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
- **A workspace missing `ModOrganizer.ini`, `mods/`, or `profiles/` isn't an MO2 instance**,
  detected structurally (existence only, never content) at activation. The Mods view shows
  persistent `viewsWelcome` content — "this isn't an MO2 instance, open the folder
  containing `ModOrganizer.ini`" — instead of an error tree. A real instance
  with a genuinely corrupt or unreadable `modlist.txt` still reports as an error
  ([ADR-0026](../adr/0026-error-surfacing-policy.md)) — that distinction is structural
  presence vs. content, not "did a read fail."
- **The welcome renders only once that check has actually run, not merely on the verdict** —
  gated on `modbench.workspaceMo2CheckDone` (a second, separate context key, set alongside the
  instance verdict on every activation exit path), so a workspace VS Code hasn't checked yet
  reads as "no welcome" rather than as a false "not an instance".
- Modbench edits mod files in place and MO2 deploys them on its next run, so the two
  **coexist at the filesystem level** — no process handoff, no VFS
  ([ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md)).

### Editing vs deploying — the central decoupling

Two independent operations against the same physical mod files:

- **Deploy (Build)** exists to let the *game* run. It hardlinks enabled mods' files into
  the game directory's `Data/`. It never needs an editing backend.
- **Edit** exists to inspect/modify *records*. The backend loads plugins by physical path
  (the load-order snapshot, ADR-0044) and writes them in place, reading vanilla masters
  from the game directory. It never needs a deployed `Data/`.

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
  Deploy/Purge are hidden and Modbench only edits in place. Executable tasks are withheld
  too — with no physical deploy of Modbench's making, an MO2 entry run outside usvfs would
  see an undeployed game directory.
- **Alpha default is `external`.** The alpha ships alongside MO2, not instead of it — MO2
  stays the deployer/launcher and the showcase is editing and mod management, neither of
  which needs a deploy. Deploy/Purge/Launch Game are withdrawn from both the title bar and
  the command palette at this default, so a fresh install exposes no path that writes into
  the game directory. Standalone deploy stays fully implemented and reachable by explicitly
  setting `deploymentMode: "standalone"`, keeping the post-alpha path testable.
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
  ([ADR-0021](../adr/0021-mod-manager-in-extension.md)).
  Persistence goes through an `IModlistSource` over an in-memory modlist model.
- **MO2 adapter** (first-class): reads/writes an instance in place — `mods/<name>/`, the
  active profile's `modlist.txt` (`+`/`-` prefixes, top of file = winning end, bottom = losing end) and
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
  switches via a quick pick and the choice is persisted back. The **load order is the active
  profile's** — switching profiles sends the new profile's snapshot to a running backend as the
  next reconcile (ADR-0044); nothing tears down.

### Backend lifecycle (editing integration)

The extension owns the editing backend process
([ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md)):

- **Spawn** — at activation (maintainer ruling 2026-09-01; a launch that found no game
  directory retries when `modbench.mods.gameDirectory` changes).
- **Load order** — sent whole as the `PUT /load-order` snapshot (ADR-0044): every physical
  plugin copy in the instance as `(name, path, origin, slot, enabled, winning)` — disabled
  entries included (ADR-0035) — with vanilla masters prepended by the backend. One backend,
  one load order — a second load on the same instance is refused (ADR-0001 point 6).
- **Teardown** — closing the workspace; there is no Close command. Restarted on crash. **Switching profile or modlist is not a
  teardown** — it sends the new profile's snapshot to the running backend as the next
  reconcile (ADR-0044); the backend keeps running (see *Profiles* above and *Profile
  selector* below, and `extension.ts`'s own comment: "a profile switch is the next
  snapshot, not a teardown").

### UI — the Mods tree

- **Header**: title "MODS"; description = current profile name; a first non-interactive
  count node ("N active / M installed"); title-bar icon buttons for Filter, Sort Direction
  and Collapse All — three, and nothing else. Switch Profile, Refresh, Deploy
  and Purge live on the [Loadout header](loadout-header.md): none of them are
  about *this tree*, and nine icons is past the point where VS Code
  keeps them visible in a narrow sidebar. Launch Game does not exist (see
  *Deploy / purge* below).
- **Structure**: separator nodes (each grouping the mods that follow it in `modlist.txt`)
  render first; ungrouped mods (before the first separator — the **winning end**) render as
  root-level items at the bottom, below every separator — no synthetic container. Separator
  nodes are collapsible and expanded by default. This is the default **losing-at-top** view
  — the losing end (base/vanilla-adjacent mods) on top, the winning end (overrides) at the
  bottom, matching MO2's default Priority-column sort. A **Sort Direction** title-bar toggle
  (triangle icon, mirroring MO2's clickable sortable column) flips the entire tree — root
  block order and the mods within each separator — to **winning-at-top** (raw `modlist.txt`
  file order). View order only — it never changes which mod wins a conflict (see
  [modmanager/CONTEXT.md](../../modbench/src/modmanager/CONTEXT.md), "View order"). The toggle
  is transient (not persisted across windows), matching the Filter/grouping toggle's
  behavior. A pinned **Overwrite** row (see *Overwrite folder* below) sits below everything
  when `overwrite/` is non-empty, outside all separator grouping.
- **Mod row**: a checkbox (enable/disable, writing the `+`/`-` prefix immediately), the
  full mod name as the label, the `meta.ini` version as the description (blank if absent), a
  generic mod icon with a status overlay (see below), and a tooltip of name · version ·
  Nexus id · archive filename.
- **Filter**: the magnifier reveals a filter input matching mod and separator names
  (case-insensitive substring). A toggle beside it controls separator behavior — **on**
  (default): sections with matches auto-expand, empty ones hide, matches show in section
  context; **off**: a flat list of matching mods, separators hidden. The toggle resets to on
  when the filter clears and is not persisted. This is the **shared filter widget** every
  Modbench list view uses — the separator toggle is an option on it, not a second
  implementation, and Downloads reuses the same widget rather than VS Code's native tree Find.

  **The filter is durable** — this section is the canonical description of behavior that
  is identical on the [Plugins tree](plugins.md) and [Downloads](downloads.md):

  - **Entry**: the slot-1 magnifier, or `ctrl+F` with focus anywhere in the view.
  - **Typing** narrows live, as it always did.
  - **The filter survives the box hiding, by every route** — Enter, Escape, clicking a row,
    clicking away. These are one event at the API (`onDidHide`) and none of them is an intent to
    discard; the box is an entry mechanism, and the filter lives in `nameFilter.ts` and each
    view's provider. Reopening the box is prefilled with the active term, so it edits rather
    than restarts. (Dismiss-clears-filter would make the filter
    usable only while typing, since clicking a result is the first thing anyone does with one.)
  - **Clearing is only ever explicit**: slot 1 swaps to a `$(clear-all)` variant while filtered,
    gated on a per-view `<viewId>.filterActive` context key — the same two-command-plus-context-key
    template as Sort Direction and Show Hidden. Typing the term back to empty also counts.
  - **Readout**: the view's own description carries the active term (`"arm"`), composed with
    whatever else that view says about itself — here the profile name (`"arm" · Default`), on the
    Plugins tree the record filter axis. **Consequence, deliberate**: because slot 1 is the Clear
    button while filtered, *editing* an active term is reached by `ctrl+F` (or clear and retype),
    not by a third title-bar icon. That is the cost of the toggle template, weighed and accepted —
    a third slot-1-adjacent icon is what rule 2 of `modbench/CLAUDE.md` exists to prevent.
  - **No matches** shows a message naming the term rather than a bare empty tree, which reads as
    "there is nothing here". Rows that survive filtering by design — an ADR-0026 error row, this
    tree's pinned Overwrite row — are content: the message asks the provider what is *showing*,
    not whether the term matched.
  - **Lifetime**: durable within the load order, across tree refreshes and underlying data changes;
    not persisted across window reloads. It is a lens, not a setting.
  - **Icon note**: `$(clear-all)` matches VS Code's own "Clear Extensions Search Results";
    the choice is recorded here rather than silently inherited.
- **Profile selector**: reached from the [Loadout header](loadout-header.md)'s Profile row,
  not this tree — switching profile swaps the modlist *and* `plugins.txt` *and* invalidates
  any running editing backend's load order, so its scope is the workspace. It opens a quick pick
  of directories under `profiles/`; selecting one persists `selected_profile`, refreshes the tree
  and asks the load-order sync for the next snapshot (ADR-0044) — a running backend reconciles
  to the new profile rather than tearing down.
- **Context menus**: a **mod** offers Open in Explorer, Add Separator Below, Move to
  Separator (quick pick of separators + "Ungrouped", moving the mod to the end of the
  section), Uninstall (confirmation; removes `mods/<name>/` and its `modlist.txt` entry),
  and View on Nexus (only when a Nexus id is present). A **separator** offers Rename, Add
  Separator Below, and Delete Separator (its mods become ungrouped / join the prior
  separator).
- **Write behavior**: every mutation (enable/disable, drag-reorder, separator ops, Move to
  Separator) writes to `modlist.txt` immediately via the active `IModlistSource`. There is
  **no save/discard flow** in this view — unlike the Editing surface, whose edits land as
  working-tree source changes reviewed and committed in the native Source Control panel
  (ADR-0041, medit-version-control.md).

### Install (Modbench-6)

- Sources: **Install from Archive…** (`.zip`/`.7z`/`.rar`) and **Install from Folder…**;
  Nexus `nxm://` install (a Downloads-tree concern) is planned — see
  [downloads.md](downloads.md).
- Flow: extract to temp staging → detect root type (`Data/` subfolder vs `.esp`/meshes at
  root) and normalise → write `mods/<name>/` + `meta.ini` via the active `IModlistSource` →
  append to `modlist.txt` **disabled** → the user enables and (standalone) deploys.
- FOMOD installers are **detected and flagged for manual setup, not executed**.

### Conflict index & status badges (Modbench-3)

- A `FileConflictIndex` (a winner map of the winning enabled mod per relative
  path — the one nearest the winning end of the Mod override order) is built on load and
  rebuilt on enable/disable/reorder. BA2/BSA archives are ordinary entries — the game's
  archive loader handles them.
- Per-mod status: **no conflicts** when all its files win; **N conflicts** when N files are
  overridden by a winning mod; **overrides N** when it overrides N files that losing mods
  also provide; **missing master** when a plugin depends on a master not in the load
  order (detected via a tiny TES4-header read, no Mutagen); **missing mod** when
  `modlist.txt` references a folder absent on disk; and **update available** (*planned*)
  when the Nexus version exceeds the installed `meta.ini` version.
- The hover tooltip lists the conflicting files and the winner. File-level conflicts here
  are distinct from record-level conflicts (the Editing context's `ConflictClassifier`) —
  each surfaces in its own view.

### Deploy / purge (Modbench-4, standalone mode)

- **Deploy**: verify same-volume (else the stock-folder / symlink-fallback prompt);
  `fs.link` each winner into `Data/<relativePath>`, skipping existing non-manifest files
  (vanilla — never overwrite); write `mods/.medit-manifest.json` listing every link.
- **Purge**: read the manifest, delete each listed hardlink, move `Data/` files that are
  neither in the manifest nor vanilla into `overwrite/` (F4SE outputs, MCM INI
  writes), then delete the manifest.
- **Excluded from the conflict index and every deploy plan** (`fileConflictIndex.ts`'s
  walk): any dot-prefixed file or directory, at any depth (a tracked mod's own
  `.git/`, `.gitignore`, editor/OS droppings), and a root-level directory literally named
  `source` (case-insensitive — Mod Management learns this by the fixed name mEdit's Track
  writes, `source/<plugin>/…`, never by calling the backend). Root-anchored: a *nested*
  directory that happens to share the name (Papyrus ships `Scripts/Source/…`, never at a mod's
  own root) still deploys normally. Neither rule needs a plugin to exist alongside it — the
  whole folder is excluded unconditionally, which is what keeps an orphaned tree (its plugin
  renamed or deleted outside Modbench) from ever becoming deployable. **Purge posture**: purge
  is manifest-exact (above), so a `.git/` that reached `Data/` under a pre-fix Modbench is
  removed by the very next purge, with no special recovery needed — the manifest never named it
  as vanilla or otherwise protected content.
- **Deploy and Purge are explicit, and independent of launching anything.** Deployment is a
  *state* of the game directory, not a per-launch transient. MO2 can treat it as transient
  because usvfs is a live VFS it holds up across however many tool runs; physical hardlinks
  have no such lifetime, so "deployed" is a mode the user is in.
- **There is no Launch Game action** (deploy, run, purge-on-exit). The affordance is the
  [Loadout header](loadout-header.md)'s
  **Launch…**, a task picker over the executables registry — one affordance that launches and
  nothing else. Deploy-run-purge coupling was
  rejected for three reasons, none of them cost: (1) *the launched process is not the game* — a script
  extender loader starts it, injects, and exits, so exit-on-child is a false signal, which is
  why MO2 tracks a whole process tree via a Job Object instead; (2) *purge mutates* — it
  sweeps non-manifest `Data/` files into `overwrite/` and prunes directories, so a false exit
  signal rearranges a running game's files; (3) *deployment must outlive any one run* —
  plugin editors and generators read the deployed `Data/`, so a transient deploy points them
  at a vanilla folder.
- **Cost was never the objection.** Measured over 15,000 files on ext4/NVMe using the
  deployer's actual sequential-await pattern: first deploy ~1.2 s, no-op re-deploy ~0.45 s,
  purge ~0.76 s, and walking a real 14,865-file `mods/` ~0.14 s (warm cache). The coupling
  was cheap and wrong, not expensive.

### Launching executables as tasks (*specced, not yet implemented*)

Everything in this section is a decision, not current behavior: today the
[Loadout header](loadout-header.md)'s Launch… affordance is placed but unwired.

Launching is a **VS Code task**, not a button. Tasks are the native "run a program" mechanism
— a picker, user-editable configuration, terminal output, exit codes — and per
[ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md) the native capability is
used rather than rebuilt. `launch.json` / `DebugConfigurationProvider` is *not* the right
native mechanism despite the name: it is a debug-adapter contract, and there is no built-in
"just run this executable" debug type, so it would mean writing a debug adapter whose only
job is spawn-and-report-exit.

**MO2's `[customExecutables]` is the launch registry.** Modbench does not synthesize an
executable path, and does not decide between the Steam copy and a stock game folder, or
between the base game and a script extender — `ModOrganizer.ini` already answers all of that
per entry, carrying `binary`, `arguments`, `workingDirectory`, `steamAppID`, `title`,
`toolbar` and `hide`. Modbench mirrors that registry; it never owns it.

- **A `TaskProvider`, not generated configuration.** `contributes.taskDefinitions` declares
  the task type; `provideTasks()` computes one task per entry at call time. No
  `.vscode/tasks.json` is written — the workspace root *is* the MO2 instance directory, so
  generating task configuration there would drop a stale, Modbench-owned file inside the
  user's modlist.
- **`ModOrganizer.ini` is re-read inside `provideTasks()`**, which VS Code calls lazily when
  the task list is needed. An executable added or edited in MO2 therefore appears without a
  restart and without a file watcher.
- **`hide` and `toolbar` decide picker prominence**, not Modbench — they already encode which
  entries the user actually launches.
- **`ProcessExecution`, never `ShellExecution`.** Real entries carry arguments of the form
  `-D:"…\Stock Game Folder\Data" -IKnowWhatImDoing` — spaces plus embedded quotes. An argv
  array skips the shell quoting layer entirely.
- **Exit codes are diagnostics, not lifecycle.** `onDidEndTaskProcess` reports the process
  Modbench launched, which for a loader is not the game. No deployment state may hang off it.

#### Path translation

MO2 entries are authored against MO2's view of the filesystem, which is neither Modbench's
nor Linux's. Two translations are mandatory:

- **Wine drive letters.** `Z:` maps to the filesystem root; `C:` maps to the Proton prefix's
  `drive_c`. `normalizeGamePath` translates each explicitly — `Z:` strips to root
  unchanged, `C:` resolves under an injected prefix detector's `drive_c`, and any other drive
  letter throws rather than guessing, since a third, user-custom-mapped letter is not
  guaranteed to live under the prefix at all. It is applied solely to `gamePath` today;
  wiring it into consuming executables' `C:` tool paths is the executables-registry scope,
  not yet built. The translation is anchored to the start of the path, so a colon inside a
  folder name (`mods/A:B/…`) survives intact; it takes the platform as an explicit argument
  rather than reading `process.platform`, and on `win32` returns the path untouched.
- **Staging-relative binaries only resolve under usvfs.** An entry may point at
  `mods/<Mod>/root/<tool>.exe`, which usvfs makes appear inside the game directory but which
  is a plain staging path to Modbench. Such an entry is remapped to its deployed location, or
  rejected with the reason surfaced — never executed at the staging path, where a loader would
  fail to find the game beside it.

#### Per-platform runner

The entry supplies *what* to run; the platform decides *how*:

- **Windows** — run the binary directly.
- **Linux** — run it inside the game's **existing** Proton prefix (`compatdata/<appid>`),
  where the script extender and installed redistributables live; a fresh prefix appears to
  work and then fails at load. `umu-run` or `protontricks-launch --appid` are preferred over
  raw `wine` because they derive `STEAM_COMPAT_DATA_PATH` and
  `STEAM_COMPAT_CLIENT_INSTALL_PATH`, which a VS Code started from a desktop entry will not
  have inherited. With neither available, fail with an actionable message rather than falling
  back to a prefix that is wrong.
- **Never `steam -applaunch`** — it launches the Steam library copy regardless of the entry's
  binary, so a stock-folder loadout would run a game *without* the deployed mods: precisely
  the silently-wrong-state failure [ADR-0026](../adr/0026-error-surfacing-policy.md) forbids.
  It also returns immediately, so it cannot report anything about the run.

Modbench runs natively on the host, so this is strictly more capable than MO2-under-Proton,
which cannot invoke a native Linux binary at all.

#### Arbitrary executables and wrapper scripts

MO2's registry is not the whole toolchain. Some tools need a hand-rolled Wine wrapper, and a
native shell script cannot be an MO2 entry at all, because MO2 under Proton has no way to
execute one. Those are declared as **ordinary `tasks.json` tasks the user writes** — already
supported by VS Code with no Modbench code. The objection above is to Modbench *generating*
that file, not to a user owning one.

The contributed task type is the integration point: a hand-written `"type": "modbench"` task
resolves through `resolveTask()`, so a user's wrapper inherits the same Proton-prefix setup
and deployed-`Data/` precondition as a mirrored MO2 entry instead of re-deriving the
environment inside a shell script.

#### Deployment precondition

A task that reads the deployed `Data/` — plugin editors and generators, declared per task —
**checks the deploy manifest first and refuses with an actionable message when nothing is
deployed.** It does not silently auto-deploy: which state the game directory is in is exactly
what a modder needs to know, and hiding it is the failure mode this decoupling exists to
prevent.

#### Tool writes

Generators write into the real `Data/`, where MO2 would have caught those writes in
`overwrite/` via usvfs. Purge's existing sweep of non-manifest, non-vanilla `Data/` files into
`overwrite/` reproduces MO2's end state, but only at purge time rather than live. That
difference is intentional and documented, not a defect.

**Cross-surface hazard**: running a plugin editor as a task while an mEdit load order holds the
same plugins indexed leaves that index stale with no notification. Resolution is deferred, and
it is an Editing-surface concern (see [medit.md](medit.md)), not a Loadout one.

### Overwrite folder

Purge sweeps `Data/` files that are neither a deployed link nor vanilla into
`overwrite/` (runtime outputs — F4SE logs, MCM INI writes). This surfaces that
folder so the user can reassign or discard those files without leaving Modbench.

- **Surface**: a single **leaf row** in the Loadout tree, pinned as the **very last row**,
  outside separator grouping. It is a read-only fixture over `overwrite/`, **not** a
  `modlist.txt` entry — so it never enables/disables, reorders, moves to a separator, or
  uninstalls like a mod.
- **Visibility**: shown **only when the folder holds ≥1 file** (counted recursively; empty
  subdirectories don't count). Driven **live** by a filesystem watcher on `overwrite/`
  (`createFileSystemWatcher`) — the row appears the instant purge deposits files and
  disappears the instant they're cleared, with **no manual refresh** in the workflow (the
  Mods tree's existing general Refresh remains only as the universal safety net for
  filesystems with unreliable watch events). Purge therefore needs no explicit refresh call.
- **Differentiation**: label `Overwrite`, its text tinted **reddish** via a
  `FileDecorationProvider` keyed on the row's `resourceUri` (`gitDecoration.deletedResourceForeground`
  — theme-adaptive for light/dark; `list.errorForeground` is the fallback if it reads too
  much like "deleted"). No badge (a right-side badge would collide with the mod rows'
  version/status description) and no text prefix (redundant once the tint marks it). The
  file count and a one-line "reassign in the Explorer or clear" help string live in the
  **tooltip**.
- **Action**: exactly one — **Open in Explorer** (reuses `revealInExplorer` → the
  left-sidebar Explorer view); single-clicking the row also reveals it. All per-file work —
  clearing, hand-reassigning — happens there with VS Code's native file operations. This is
  deliberate: we don't rebuild file management VS Code already provides (see
  [modbench/CLAUDE.md](../../modbench/CLAUDE.md) invariants).
- **Deliberately not built** (each redundant with the Explorer view, or a no-op in our
  model): a dedicated **Clear** action (→ multi-select delete in the Explorer view);
  **Move-to-existing-mod** (→ drag files into `mods/<target>/` in the Explorer, which is
  already registered — no `modlist.txt` write needed); **Sync-Overwrite** (MO2 needs it
  because its VFS lets a tool overwrite a mod's file; our **hardlink** deploy edits the
  mod's file in place, so overwrite only ever holds orphan runtime outputs with no owning
  mod — nothing to sync). **Create-Mod-from-Overwrite** is **deferred**: it needs a
  `modlist.txt` write so it isn't Explorer-doable, but overwrite is usually junk-contaminated
  so whole-folder packaging is rarely clean; the better future shape is **draggable file
  sub-rows** (drag wanted files onto a newly-created empty mod), tracked separately.
- **Seam**: a tiny pure "is-non-empty + recursive file count" helper (unit-tested, no
  `vscode` import), a new `OverwriteNode` in `ModListProvider`, the watcher wiring, and a
  one-line `FileDecorationProvider`. No C# backend involvement (Mod Management is
  extension-only).

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
- **Non-regular dirents inside `mods/<Mod>/`**: a symlink is followed transparently —
  file or directory — and participates in the index and deploy like a real entry, matching
  what `references/modorganizer/`'s own walker does with a reparse point. A symlinked file
  deploys as a real hardlink to the resolved target, not a duplicated symlink — `fs.link`'s
  final path component doesn't dereference on Linux, so the index records the realpath-
  resolved file as the deploy source while keeping the symlink's own name as its relative
  path in the mod tree; a symlinked directory needs no such resolution, since only its final
  path component is a link. A broken symlink (ENOENT) or a symlink cycle is skipped and
  logged, never thrown (MO2 leans on NTFS's reparse-hop ceiling for the cycle case, which has
  no Linux equivalent here, so this walker tracks its own ancestors); any other stat failure
  (e.g. permission denied) propagates rather than silently degrading to a skip. A socket,
  FIFO, or device node is never mod content — always skipped, always logged. A per-winner
  link failing with EXDEV (the resolved source landing on a different volume than `Data/` —
  the shared-asset-folder scenario, on another disk) is reported per file rather than
  aborting the deploy.
- **Prior art**: `modlistText.test.ts`, `metaIni.test.ts`, `modOrganizerIni.test.ts`,
  `statusChecker.test.ts` — fixture-in / value-out style; real MO2 instance fixtures live
  under `modbench/src/modmanager/test/fixtures/`.
- **Task-provider seams** (Vitest, no VS Code): parsing `[customExecutables]` into entries —
  Qt's `<n>\key` array numbering, `Z:` versus `C:` drive translation, staging-relative binary
  detection — asserted fixture-in / value-out against a real `ModOrganizer.ini`; and the
  per-platform runner, asserted as a value (`{ command, args }`) without spawning anything.
- **Reused integration seam** (`npm run test:integration`, real VS Code process): the tree
  renders from an instance; a checkbox toggle and a drag-reorder round-trip to
  `modlist.txt`; install from archive lands a disabled mod; profile switch reloads.

## Out of Scope

- **FOMOD scripted installers** (`fomod/ModuleConfig.xml`) — a significant sub-project;
  currently detected and flagged for manual setup rather than executed.
- **Full Vortex management** — only a deferred read-only snapshot via
  `vortex.deployment.json` is contemplated; no text modlist exists to manage.
- **Nexus integration** (`nxm://` install, update-available badge, endorsements) — a
  Downloads-tree concern; see [downloads.md](downloads.md).
- **Plugin load-order management** (`plugins.txt` reorder/enable, missing-master, auto-sort)
  — its own Mod-Management surface; see [plugins.md](plugins.md).
- **Per-profile isolated saves and base-game config** (`local savegames` / INI) — optional
  MO2 features, deferred.
- **Delta / overlay editing** — loading an arbitrary overriding-plugin set side-by-side
  (xEdit-like) builds on the load-order snapshot; deferred.
- **Reimplementing modding tools natively** — plugin editors, patcher frameworks and LOD/
  texture generators are *invoked* as tasks, not rebuilt. A task buys invocation, not
  integration: no output parsing, no conflict awareness, no result surfacing.
- **Building or repairing Proton prefixes** — Modbench runs inside the prefix the game already
  has. Creating one, installing redistributables, or assigning a compatibility tool stays with
  Steam and protontricks.
- **Editing MO2's `[customExecutables]`** — *deferred, not rejected*. The registry is mirrored
  read-only for now; adding or changing an executable is done in MO2, or as a user-owned
  `tasks.json` entry. Write support is wanted eventually — the long-term goal is for Modbench
  to replace MO2 outright — and would follow the same byte-faithful surgical-edit rule as
  every other `ModOrganizer.ini` write. A guided wizard for adding executables is a separate
  and much later question, and may never be worth building.

## Further Notes

- **Open questions carried forward**: MO2 round-trip fidelity needs a corpus of real MO2
  instances so separators/categories/unmodelled constructs are proven to survive verbatim;
  and the Vortex adapter awaits confirmation that `vortex.deployment.json` is stable enough
  to bother with.
- **Vision**: one tool handles the whole modding workflow — install → manual sort → launch
  → inspect conflicts → edit records → patch — with the Mods view and the mEdit views side
  by side, and editing never requiring a deploy.
