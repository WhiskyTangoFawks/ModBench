# Downloads — Surface Specification

**Status: Implemented.** The tree, queue watcher, install/hide/delete/filter/sort commands
(12 `modbench.downloads.*` commands) all ship; a `nxm://` protocol handler and authenticated
Nexus API integration remain out of scope (see Nexus login below).

 Feature landscape:
[mod-manager feature inventory](../research/mod-manager-feature-inventory.md).

Mod Management context — operates on downloads and mods; never on records.
The mEdit-context vocabulary ("record", "FormKey") is absent here by construction
([CONTEXT.md](../../CONTEXT.md)).

Placement: [ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md) — a native
sidebar `TreeView` (`modbench.downloads`), third in the `modbench` container
below Mods and Plugins, registered collapsed by default. Downloads is occasional/rich
rather than something referenced mid-navigation, so it doesn't compete with Mods and
Plugins for attention until there's something to act on — a placement decision, not a
webview one; the surface that shipped (four user-visible fields — label, status,
description, tooltip — behind a native context menu) has nothing an editor tab's extra
width was ever needed for.

MO2 behavioral reference: `modorganizer/src/downloadmanager.cpp` (the `.meta` state
semantics this spec mirrors) and `modorganizer/src/downloadlist.cpp` (the Status word/
colour convention — `downloadlist.cpp:196` uses "Uninstalled", not "Removed").

## Problem Statement

A user pointing Modbench at an MO2 instance can manage and deploy the mods they've
already installed, but has no view of the **downloads** sitting in the instance's
`downloads/` folder. In MO2 the Downloads tab is where you see what you've fetched,
install a download into the loadout, tell at a glance what's already installed, revisit
a mod's Nexus page, and clear out clutter. Without it, the user has to leave Modbench
and use MO2 (or a file manager) to do any of that — breaking the "point Modbench at an
MO2 folder and work on the loadout in place" promise.

## Solution

A **Downloads tree** — a sidebar `TreeView` listing the downloads in the instance's
shared `downloads/` folder, one leaf row per file, with per-row actions (Install, Visit
on Nexus, Open File, Open Meta File, Delete, Hide/Unhide) and a small toolbar (Show
hidden, Sort by…). The tree is a **live file view**: a file-watcher keeps it in sync as
downloads appear or change on disk (dropped in via the OS file manager today; delivered
by the `nxm://` download handler later). It mirrors MO2's Downloads tab closely enough
that a user can alternate between MO2 and Modbench on the same instance, while fixing
MO2's one UX wart — batch cleanup actions are kept out of the per-row context menu, and
apply to a multi-selection instead. The row's right-click menu is VS Code's own native
`view/item/context` menu (see
[ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)), not a rendered
overlay.

The tree reads the per-download `.meta` sidecar MO2 already writes: it derives each
row's Status from that file and, on a successful Install, writes the install state back
to it — so the loadout and the Downloads view stay consistent with MO2's own
bookkeeping.

## User Stories

1. As a mod author curating a loadout, I want a Downloads tree in the sidebar showing
   the downloads in my instance's `downloads/` folder, so that I can see everything
   I've fetched without leaving Modbench.
2. As a user, I want each download shown as a single row with its filename, so that the
   list maps one-to-one to the files on disk.
3. As a user, I want the download's `.meta` sidecar to *not* appear as its own row, so
   that the list isn't cluttered with bookkeeping files.
4. As a user, I want each row's status shown at a glance — Downloaded, Installed, or
   Uninstalled — via a coloured icon, so that I can tell what I still need to install
   without opening anything.
5. As a user, I want the download's size available on the row, so that I can gauge how
   large a mod is.
6. As a user, I want the download's file time available on the row, so that I know when
   I fetched it.
7. As a user, I want the list sorted newest-first by default, so that the mod I just
   downloaded is at the top.
8. As a user, I want a "Sort by…" command offering every sortable field in both
   directions, so that I can group by Status or find a mod by name or size — the tree
   equivalent of clicking a column header, since a tree row has none to click.
9. As a user, I want to right-click a row and Install that download into my loadout, so
   that I can add a downloaded mod without re-picking the file from a dialog.
10. As a user, I want a download's Status to flip to Installed immediately after I
    install it, so that the list reflects what I've done.
11. As a user, I want to Visit on Nexus from a row, so that I can open the mod's page to
    read about it or check for updates.
12. As a user, I want the Visit on Nexus action unavailable when the download has no
    Nexus mod id, so that I'm not offered a link that can't work.
13. As a user, I want to Open File on a row, so that I can inspect the download's
    contents in my system's associated application.
14. As a user, I want to Open Meta File on a row, so that I can read or hand-edit the
    `.meta` sidecar when I need to — and my edit is read back correctly whether or not I
    leave spaces around `key = value`, which MO2's own writer never emits but a hand-edit
    naturally produces.
15. As a user, I want Open Meta File unavailable when there's no sidecar, so that I'm
    not offered an action with nothing to open.
16. As a user, I don't need a separate "Reveal in Explorer" row action, because the
    instance's `downloads/` folder already sits inside VS Code's own Explorer at the
    workspace root — so I can find any file there directly, with nothing Downloads-
    specific to add.
17. As a user, I want to Delete a download from a row, so that I can reclaim disk space.
18. As a user, I want Delete to remove both the download and its `.meta` sidecar, so
    that I don't leave an orphaned metadata file behind.
19. As a user, I want Delete to move files to the system trash rather than erasing them,
    so that I can recover from a mistake.
20. As a user, I want Delete to ask for confirmation, so that I don't lose a download by
    a stray click — once for the whole selection when I've selected several.
21. As a user, I want deleting a download to leave the installed mod untouched, so that
    freeing download space never uninstalls anything.
22. As a user, I want to Hide a download I don't want to see, so that I can declutter
    the list without deleting the file.
23. As a user, I want hidden downloads filtered out of the list by default, so that
    hiding actually declutters.
24. As a user, I want a "Show hidden" toggle, so that I can bring hidden downloads back
    into view when I need them.
25. As a user, I want hidden downloads shown dimmed when "Show hidden" is on, so that I
    can tell them apart from visible ones.
26. As a user, I want to Unhide a download while hidden ones are shown, so that I can
    undo a hide.
27. As a user, I want to select several rows and Delete, Hide, or Unhide them together,
    so that clearing out a batch of downloads doesn't take one click per file.
28. As a user, I want the list to update on its own as files change in `downloads/`, so
    that downloads I drop into the folder appear without my doing anything.
29. As a user, I want to drop files into the `downloads/` folder from my OS file
    manager and have them show up in the tree, so that adding a manually-downloaded mod
    is frictionless.
30. As a user, I want a clear "no downloads yet" message when the tree is empty, so
    that I know the tree is working and just has nothing to show.
31. As a user, I want the Downloads tree available from the command palette (VS Code
    auto-generates a "Focus on Downloads View" command for any contributed view) and
    always present — collapsed, not hidden — in the sidebar stack, so that I can get to
    my downloads without a bespoke open command or toolbar button anywhere else.
32. As a user with a long downloads folder, I want to narrow to matching rows by name with
    the same filter I use on every other Modbench list, so that I can find one without
    scrolling and without learning a second way to search (VS Code's native tree Find
    remains available on this tree as it is on every tree).
33. As a user installing a download whose Nexus mod id I already have installed, I want
    Modbench to ask which installed mod it upgrades, with the likely one pre-selected, so
    that a mod author's file naming never writes over the wrong folder.
34. As a user installing a second file from a page I've already installed, I want an
    "Install as a new mod…" option in that same pick, so that optional files and patches
    still install as their own mod.

## Implementation Decisions

### Scope

- This spec covers the **Downloads tree surface only** — the sidebar `TreeView`, its
  row rendering, toolbar, row actions, and the live file view over `downloads/`.
- The `nxm://` protocol handler and Nexus API integration are **out of scope**
  — a download/protocol handler, not UI. **Deferred past alpha to milestone "7 — Nexus
  integration":** `nxm://` is a signed handle, not a download URL, so it (and any metadata
  enrichment) requires the *authenticated* Nexus API, which requires registering Modbench
  as a Nexus application (staff outreach). Modbench does not intercept Nexus downloads —
  the browser owns the transfer and this tree's file-watcher surfaces the result. When
  built, the handler will populate the same `downloads/` folder this tree watches.
- Update checks are **out of scope** — a Mods-tree concern (you update an
  *installed* mod), and likewise deferred to milestone "7 — Nexus integration" (needs the
  authenticated Nexus API).
- Endorsements / mod tracking are **out of scope** — a Mods-tree concern.

### Downloads directory

- The tree views the MO2 instance's shared `downloads/` folder
  (`<instanceRoot>/downloads/`), per
  [ADR-0016](../adr/0016-mod-management-lives-in-the-extension.md).
  Not a Modbench-private location — a user must be able to alternate between MO2 and
  Modbench on the same instance with no divergence.
- Retention (keep vs. purge downloads after install) is **not a Downloads-tree decision**:
  the tree only views files; it imposes no keep/purge policy.

### Row model & the `.meta` sidecar

- **One row per download.** The `.meta` sidecar is suppressed as its own row and read as
  the data behind the download's row.
- **Status is read from the `.meta`**, mirroring `downloadmanager.cpp`:
  - `installed=true` → **Installed**
  - `uninstalled=true` → **Uninstalled**
  - neither flag → **Downloaded**
- A download with **no `.meta` sidecar** (e.g. a manually-dropped file) is a valid row:
  Status **Downloaded**, with Nexus/meta actions gated off (below).
- **Nexus identity is read from the `.meta`**: `modID` and `fileID`, each absent when missing
  or `0`. The file id is what an upgrade pre-selects by; a filename is never consulted.

### Row rendering

Each `.meta`-suppressed file in `downloads/` becomes one `DownloadNode` `TreeItem`
(`DownloadsProvider.ts`). While the Instance's first read has failed and nothing has landed, the
tree is instead one error node carrying the read's reason, and the injected reporter is told
once ([ADR-0019](../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md)); the next landed value replaces it
with rows.

- **Label** — `.meta` `name` when present and non-empty, else the raw filename (never
  blank, mirroring MO2's `displayNameByInfo`). This is a friendly display name, not the
  identifier: mutations, selection, and `id` all key off the raw filename.
- **Status icon + colour** — a `ThemeIcon`, always set explicitly so the file-icon theme
  never takes over: `archive`/green for Downloaded, `check`/no explicit colour for
  Installed, `circle-slash`/yellow for Uninstalled, mirroring `downloadlist.cpp`'s
  Status-cell colours (`STATE_READY`→green, `STATE_UNINSTALLED`→yellow). This is the
  Mods tree's own icon-carries-status convention (`ModListProvider`'s `statusIconId`),
  not a Downloads invention. A **file-type icon was considered and rejected** — every row
  in this tree is the same kind of file (a compressed download), so a file-type icon
  would be a constant, carrying no information a fixed icon doesn't already convey; the
  icon slot is spent on Status instead.
- **Description** — the `.meta` version (`v2.2.1`) plus the status word, the latter
  omitted when the status is the default (Downloaded), mirroring `ModNode`'s
  description convention: the icon always carries status, the description repeats it
  only when it's not the unmarked default.
- **Tooltip** — a `MarkdownString`: filename, mod name, version, Nexus ID, size,
  filetime, game, and author — each field present only when the `.meta` (or, for
  filename/size/filetime, the filesystem) actually records it, so a metaless download
  still gets a valid, minimal tooltip. Size and filetime live here rather than as columns.
- **`resourceUri`** — `downloads/<name>` as a file `Uri`. It exists to feed
  `HiddenDownloadDecorationProvider`'s dimming lookup (below), not to derive the icon —
  `iconPath` is always explicitly set, so the file-icon theme is never consulted.
- **`id`** — pinned to the raw filename, never the label, so a later `.meta` name change
  can't silently drop the user's tree selection (`TreeItem.id` otherwise auto-derives
  from the label).
- **`contextValue`** — see *Row context menu* below.

### Toolbar

- **Show hidden** — a title-bar toggle pair (`modbench.downloads.showHidden` /
  `.hideHidden`), off by default. The glyph names the *current state*, not the action a
  click performs: closed eye when off (default — hidden entries not shown) and open eye
  when on (hidden entries shown); the tooltip names the action ("Show Hidden Downloads" /
  "Hide Hidden Downloads"). It's **additive, not an exclusive filter** (matching MO2's own
  Show-hidden, `downloadmanager.cpp:102`): turning it on shows hidden rows *alongside*
  visible ones, dimmed via `HiddenDownloadDecorationProvider`, rather than switching to a
  hidden-only view.
- **Sort by…** — a command in the view's `…` overflow menu (no icon, so it doesn't
  compete for title-bar space): a `showQuickPick` over the four sortable fields (Name,
  Status, Size, Filetime) in both directions. Default remains Filetime descending.
  The sort is **stable in both directions** — rows tied on the sorted field keep their
  prior relative order, ascending or descending. This matters most on Status, which has
  only three values, so ties are the common case rather than the exceptional one.
- **Filter** (`modbench.downloads.filter`, slot 1) — the shared Modbench filter widget,
  narrowing to rows whose filename contains what the user types, case-insensitively.
  Render-only: a keystroke never re-pulls the Instance value the rows are built from.

  Applied **after hidden-filtering**: Show Hidden decides which rows exist, the name filter
  narrows what is left. Behavior — durable until explicitly cleared, `ctrl+F` entry, term in the
  view description, `modbench.downloads.clearFilter` at slot 1 while active — is identical to
  every other Modbench list view and specified once, in [mods.md](mods.md).

  VS Code's **native tree Find** (`list.find`) was considered for this list and rejected: the
  shared widget is what makes "narrow this list by name" mean one thing across every title
  bar, and its structural-vs-flat toggle is an option on the widget, not the widget itself —
  Downloads reuses the one widget, with no toggle.
- **No manual Refresh** — no view has one. Refresh is a single workspace-scope
  command on the [Toolbox](containers.md) that re-reads every Mod-Management source
  together, the Instance included. It remains only a safety net for filesystems with
  unreliable watch events: the Instance's own `downloads/` watcher (`downloadsWatcher.ts`)
  is what normally brings a change back, with no user action needed.

### Live updates

- The **Instance** (ADR-0015) owns the one watcher over `downloads/`: downloads (and
  `.meta` changes) added, removed, or modified on disk land in its next recomputed value,
  and `DownloadsProvider` re-renders from that value on every landing — no user action and
  no manual Refresh (see *Toolbar* above). Events are debounced (200ms) so a single logical
  file operation (e.g. a download write followed by its `.meta` sidecar write) recomputes
  once, not once per file.

### Row context menu

Kept scoped to actions a row (or a selection of rows) can take — batch/category actions
apply to the multi-selection rather than living in a separate dropdown (MO2's conflation
of the two in one menu is the UX wart being fixed).

**The menu is VS Code's own native `view/item/context` menu**, contributed in
`package.json` and gated on the row's `contextValue` — a space-separated flag string
(`downloadContextValue`, `mo2Codecs/downloads.ts`): the base `download` token plus `hasMeta`,
`hasModID`, and/or `hidden` when true. Each `when` clause tests a flag via a
word-boundary regex (`viewItem =~ /\bflag\b/`), so flag order never matters — the
same `contextValue`-flag-string idiom Mods/Plugins use.

**Twelve commands** (install, visitNexus, openFile, openMeta, delete, hide, unhide, filter,
clearFilter, sortBy, showHidden, hideHidden) — no Reveal in Explorer (see user story 16): the
tree lives beside the workspace's own Explorer, so an in-tree reveal action is redundant.

- **Install, Visit on Nexus, Open File, Open Meta File** act on the **clicked row only**,
  ignoring any multi-selection. VS Code invokes a `view/item/context` command as
  `(clickedItem, selectedItems[])`; these four simply don't read the second argument.
  MO2 doesn't batch Install either, and batching a navigational action reads as "open
  five browser tabs / five downloads / five editors" — not useful.
  - **Install** — reuse the existing `modbench.modList.installFromArchive` flow
    (extract → detect root → install into the loadout, stamping `installationFile` into
    the new mod's `meta.ini`), pre-supplied with this row's download path (skipping the
    file-picker). When the download's Nexus mod id matches an installed mod's, **the
    upgrade pick** (below) runs first; its outcome rides along as a fifth argument — the
    install target, either an upgrade naming the chosen mod or a new mod, which is what
    sends the command to its name prompt. With no pick, the argument is a new mod. On **success**,
    write `installed=true` back to the download's `.meta`, so the row's Status
    transitions Downloaded → Installed live via the watcher.
  - **The upgrade pick** — `selectUpgradeCandidates` (`upgradeCandidates.ts`), pure over
    the Instance value and the download's `modID`/`fileID`, finds the installed mods
    whose meta.ini mod id equals the download's; each candidate carries whether meta.ini's
    own `installedFiles` records the download's file id, or failing that whether the
    download named by the candidate's `installationFile` does. Filename is never
    consulted. **No candidates** — no mod id on the download, or no installed mod sharing
    it — skips the pick and installs exactly as before. Otherwise a `QuickPick` shows one
    row per candidate (label: mod name and version; description: "File ID match" when
    that candidate matched, named and sorted first, which is what makes it the QuickPick's
    default-highlighted row) plus a trailing "Install as a new mod…" row. Choosing a
    candidate yields an upgrade of that mod's folder, replaced in place (ADR-0015 invariant 2);
    choosing "new mod" yields a new mod, which reaches the name prompt. **Esc** yields
    nothing at all and installs nothing.
  - **Visit on Nexus** — open `https://www.nexusmods.com/{gameSlug}/mods/{modID}`, where
    `gameSlug` derives from the instance's game (the existing MO2 game-name → Nexus-slug
    mapping) and `modID` from the `.meta`. **Gated off** when there's no `modID`
    (`when` checks `hasModID`).
  - **Open File** — OS-open the download in the system's associated application.
  - **Open Meta File** — open the `.meta` sidecar in the editor. **Gated off** when
    there's no sidecar (`when` checks `hasMeta`).
- **Delete, Hide, Unhide** act on the **whole selection**.
  - **Delete** — move both the download and its `.meta` sidecar (if any) to the system
    trash, behind a confirmation. A multi-item selection confirms **once for the whole
    batch**, never once per file (`deleteArchives`); a single-item selection reuses the
    exact single-file confirmation text. Removes files only; never uninstalls the mod
    that was installed from the download.
  - **Hide / Unhide** — two commands (`modbench.downloads.hide` / `.unhide`), mutually
    exclusive in the menu via `when: !hidden` / `when: hidden` on the *clicked* row, so
    only one ever shows. Hide sets `removed=true` in the `.meta` (filtering the row out
    unless *Show hidden* is on); Unhide clears it. Both are **idempotent per row**
    (always writing `removed=true`/`false` regardless of the row's prior state), which
    is what makes them safe over a **mixed hidden/visible selection**: the `when` clause
    deciding which of the two commands appears can only inspect the clicked row (there
    is no `when` primitive for "the selection is mixed"), so whichever action that row's
    state offers gets applied to every selected row — matching MO2's own "Hide All"
    rather than erroring on a mixed batch.

### Placement & entry point

- A sidebar `TreeView` (`modbench.downloads`), third in the `modbench` view container's
  `modbench` container below Mods and Plugins, registered `"visibility": "collapsed"` by
  default — always present, never opened via a command.
- **Entry point**: VS Code auto-generates a `modbench.downloads.focus` command for any
  contributed view (surfaced in the command palette as "Downloads: Focus on Downloads
  View"); no bespoke `modbench.downloads.open` command and no Mods-toolbar button exist
  or are needed.
- The ambient "↓ N downloading" status-bar item and MO2's inline green progress bar are
  **described here but deferred to the `nxm://` handler** — nothing is mid-download in this MVP.

### Architecture / seams

- **The pure `downloads` model** (`mo2Codecs/downloads.ts`) is **placement-agnostic** —
  `buildDownloadRows`, `sortDownloadRows`, `filterHiddenRows`,
  `parseDownloadMeta`, `downloadContextValue`, and the `.meta`-mutation surgical text
  transforms (`setInstalledInText` / `setUninstalledInText` / `setHiddenInText`) know
  nothing of the tree. This mirrors the existing pure-logic layer
  (`statusChecker.ts`, `metaIni.ts`, `modlistText.ts`).
- **`DownloadsProvider` / `DownloadNode`** (`DownloadsProvider.ts`) is a thin
  `TreeDataProvider` reading the Instance's `downloads` field (ADR-0015): it owns no scan
  and no watcher of its own, runs the pure model over the Instance's rows to build
  render-ready ones, turns each into a `TreeItem` (see *Row rendering*), and holds the
  toolbar's transient view state (`showHidden`, `sortColumn`, `sortDescending` — reset on
  every activation, never persisted, matching the Mods tree's Sort Direction toggle). It
  subscribes to the Instance at construction; each landed value calls `invalidate()`, which
  clears the cache and fires `onDidChangeTreeData`. A mutation from a row command reaches
  the tree the same way — through the Instance's watcher over `downloads/`, not a direct
  push from the command.
- **`contextValue` carries the row's own gating state.** `downloadContextValue` produces the
  space-separated flag string a native `view/item/context` `when` clause can regex-match
  directly.
- **`DownloadsPanel.ts`** is action functions plus command registration only — no
  webview, no `postMessage`, no panel lifecycle. The seven per-archive action functions
  (`installArchive`, `visitOnNexus`, the two nav actions, `deleteArchive`,
  `setArchiveHidden` for hide/unhide) are module-private; `registerDownloadsSingleRowCommands`
  wires the clicked-row-only four straight to `vscode.commands.registerCommand`, and
  `registerDownloadsMultiRowCommands` wires the selection-wide three the same way (Delete
  additionally routing through the batch-confirming `deleteArchives`) — every command id has
  its own direct `registerCommand` call, no id -> handler lookup table in between.
  `registerDownloadsSortCommand` and `registerDownloadsHiddenToggleCommands` wire the
  toolbar. Every command calls its action function directly — no round trip.
  `installArchive` additionally takes the Instance (read-only) to run the upgrade pick
  before it calls the install command.
- **`upgradeCandidates.ts`** (`selectUpgradeCandidates`) is the pure candidate-selection
  seam the upgrade pick is built on: an `InstanceValue` and a download's `modID`/`fileID`
  in, ordered `UpgradeCandidate[]` out, no `vscode` import. `DownloadsPanel.ts`'s
  `upgradePickItems` is the one place that turns a candidate into a `QuickPickItem`.
- **`downloadsWatcher.ts`** is the Instance's own watcher over `downloads/` (ADR-0015); the
  tree has no watcher of its own and there is no manual Refresh — see *Toolbar*.
- **`HiddenDownloadDecorationProvider`** dims hidden rows: a stateless
  `FileDecorationProvider` keyed on `resourceUri`, reading `DownloadsProvider.hiddenNames()`
  live on every call. It exists only because Show hidden is additive (hidden rows render
  alongside visible ones with no separate list), so a visual cue is the sole way to tell
  them apart — MO2 itself draws none.
- **`deleteDownload`** (`modmanager/commands/downloads.ts`, no `vscode` import) owns the
  trash-both-files ordering (`.meta` before the download, so a mid-failure never orphans
  a sidecar) and takes the trash call as an argument, which `DownloadsPanel.ts`'s VS Code
  adapter supplies along with the confirm and the report.

## Testing Decisions

- **Good tests here assert external behavior, not implementation details.** For the
  `downloads` model that means: given a directory listing + `.meta` contents, assert the
  produced rows (and their Status / hidden / action-enabled flags / order); given a
  `.meta` text + a mutation, assert the resulting text. No assertions about private
  helpers or call sequences.
- **Primary unit seam — the `downloads` model module** (`mo2Codecs/test/downloads.test.ts`, Vitest,
  `npm run test:unit`, no backend): filename → row mapping with `.meta` sidecars
  suppressed; Status derivation (`installed`/`uninstalled`/neither/no-`.meta`); hidden
  filtering; default and re-sort ordering; `downloadContextValue`'s flag-string output;
  the three mutation functions, byte-faithfully.
- **`DownloadsProvider.test.ts`** (Vitest): `DownloadNode` row rendering (label/id, status
  icon+colour, description, tooltip composition including the metaless-minimal case,
  `contextValue`, `resourceUri`); provider behavior against a fake Instance — rows come
  from the Instance value alone (fixtures, never real fs), default sort, hidden exclusion,
  `setShowHidden`/`setSort` re-rendering and firing `onDidChangeTreeData`, `hiddenNames()`,
  the empty-value state, the `sequence === 0` "not read yet" guard, the failed-first-read error
  node with its one report, and re-rendering off a newly published Instance value past a
  macrotask boundary.
- **`DownloadsPanel.test.ts`** (Vitest, `vscode` stubbed the way `ModListProvider.test.ts`
  does): `registerDownloadsSingleRowCommands` / `registerDownloadsMultiRowCommands` exercised
  by capturing the mocked `vscode.commands.registerCommand` calls and invoking the captured
  callback with `DownloadNode`-shaped arguments (real fixture-in / real-fs-out) — install
  (success/cancel/throw), delete (confirm-cancel/confirm-accept/selection-fallback), hide/unhide
  (including the mixed-selection idempotency case), visitNexus (with/without modID), and the nav
  actions, all through the actual registered callback rather than a handler reached by any other
  path; `deleteArchives`' once-for-the-whole-batch confirmation, including the
  single-item-reuses-singular-text case; `registerDownloadsSortCommand` and
  `registerDownloadsHiddenToggleCommands` against the mocked provider. The upgrade pick, against
  a scripted `Pick<Instance, 'value'>` and the mocked `vscode.window.showQuickPick` (never real
  VS Code UI): the pick's rows, their order and the file-id match's active-row placement;
  the upgrade shape a candidate row yields and the new-mod shape the trailing row yields;
  choosing either carries that shape into the install command; Esc never calls the install
  command at all; a download with no mod id, or one an installed mod does not share, never
  shows the pick and installs as a new mod.
- **`upgradeCandidates.test.ts`** (Vitest, no `vscode`): `selectUpgradeCandidates` as a pure
  function over fixture `InstanceValue`/download shapes — one candidate with a file-id match,
  several without, none (no mod id on the download, and no installed mod sharing one that is
  present), and a match found only through the sidecar named by `installationFile`.
- **`modManagementCommands.test.ts`**: `registerModInstallCommands`'s `installFromArchive`
  command — an upgrade target bypasses `promptModName` and installs as that upgrade; a new-mod
  target, and the Mods-view entry that supplies none, reach the prompt and install as a new mod
  under the prompted name; cancelling the prompt installs nothing. The Mods-view
  `installFromFolder` entry likewise installs as a new mod.
- **`downloadsWatcher.test.ts`**: debounces multiple rapid fs events into one `onChange`
  call.
- **`HiddenDownloadDecorationProvider.test.ts`**: decorates only rows both under the
  `downloads/` prefix and named in the live `hiddenNames()` set.
- **`commands/downloads.test.ts`**: the trash-`.meta`-before-download ordering, the
  confirm-gate, and cancel-is-a-no-op.
- **Prior art**: `metaIni.test.ts`, `modlistText.test.ts`, `statusChecker.test.ts`,
  `modOrganizerIni.test.ts` — same fixture-in / value-out style; instance fixtures live
  under `modbench/src/modmanager/test/fixtures/`.
- **Reused integration seam** (`npm run test:integration`, real VS Code process,
  `extension.test.ts`'s `modbench.downloads` tree block): the tree renders from a real
  instance; a dropped-in file is reflected through the Instance's watcher with no manual
  refresh; and all twelve `modbench.downloads.*` commands register, asserted via
  `EXPECTED_COMMANDS`.
- The `when`-clause gating in `package.json` itself isn't exercised by any test
  (declarative, verified manually), same caveat as every other native context menu in
  this codebase.

## Out of Scope

- **`nxm://` protocol handler + Nexus API integration** — populates the same
  `downloads/` folder later; can lift from `modorganizer/` source when built. **Deferred
  past alpha to milestone "7 — Nexus integration"** — needs an OS-level `nxm://` broker
  (MO2's `nxmhandler.exe` pattern) plus the authenticated Nexus API, gated on registering
  Modbench as a Nexus application (staff outreach).
- **Update checks** and **endorsements / mod tracking** — Mods-tree concerns.
- **Meta-vs-reality Status validation** — the tree trusts the `.meta`
  unconditionally. Correlating each download against the actually-present installed
  mods (via `installationFile`) to catch drift is a follow-up.
- The **status-bar item and in-progress/downloading state** — described above but
  implemented with the `nxm://` handler.
- **Drag-to-install onto the Mods tree** — no `TreeDragAndDropController` is registered
  on `modbench.downloads`; Install stays a context-menu/command action. A drag affordance
  is a plausible future convenience, not a gap in this slice.
- **MO2's "info incomplete" warning icon** — MO2 flags a download whose `.meta` metadata
  fetch never completed; this tree has no equivalent icon. Every row here already
  degrades gracefully to a minimal Downloaded row with no metadata, so there's nothing
  distinct to warn about yet.
- **Compact/standard row density** — no density option exists; row rendering is fixed,
  matching every other Modbench tree.

## Further Notes

- **What the alpha's Downloads surface actually is**: the `modbench.downloads` sidebar
  `TreeView`, collapsed by default, reachable via the command palette or by expanding it
  in the `modbench` container — no separate command to open it, no columns, no
  manual Refresh (a name filter exists — Slot 1 above — this is about the absence of a
  data-refresh control). Live entirely off `downloadsWatcher.ts` and the pure `downloads` model
  in `mo2Codecs/downloads.ts`.
- Consequence of ADR-0017: this surface's shape — sidebar tree, collapsed by
  default, status-bar item deferred to Nexus integration — is resolved; downloads
  directory, endorsements and retention are closed by the Implementation Decisions above.
