# Downloads — Surface Specification

**Status: Specced — MVP ready to build.** This spec supersedes the earlier skeleton;
its shape was confirmed in a grilling session (2026-07-09). Feature landscape:
[mod-manager feature inventory](../research/mod-manager-feature-inventory.md).

Mod Management context — operates on downloads, archives, and mods; never on records.
The mEdit-context vocabulary ("record", "FormKey") is absent here by construction
([CONTEXT-MAP.md](../../CONTEXT-MAP.md)).

Placement: [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md) — an
editor-tab webview (the same mechanism as the mEdit Record Editor panel and
`modbench.openEditor`), not a sidebar tree. Downloads is occasional/rich rather than
something referenced mid-navigation, so it doesn't compete for the permanent sidebar
slots Mods and Plugins occupy, and it gets full editor width for the columns below.

MO2 behavioral reference: `modorganizer/src/downloadmanager.cpp` (the `.meta` state
semantics this spec mirrors).

## Problem Statement

A user pointing Modbench at an MO2 instance can manage and deploy the mods they've
already installed, but has no view of the **archives** sitting in the instance's
`downloads/` folder. In MO2 the Downloads tab is where you see what you've fetched,
install an archive into the loadout, tell at a glance what's already installed, revisit
a mod's Nexus page, and clear out clutter. Without it, the user has to leave Modbench
and use MO2 (or a file manager) to do any of that — breaking the "point Modbench at an
MO2 folder and work on the loadout in place" promise.

## Solution

A **Downloads tab** — an editor-tab webview listing the archives in the instance's
shared `downloads/` folder as a sortable table (Name / Status / Size / Filetime), with
per-row actions (Install, Visit on Nexus, Open File, Open Meta File, Reveal in Explorer,
Delete, Hide/Unhide) and a small toolbar (Refresh, Show hidden). The tab is a **live
file view**: a file-watcher keeps it in sync as archives appear or change on disk
(dropped in via the OS file manager today; delivered by the `nxm://` download handler
later). It mirrors MO2's Downloads tab closely enough that a user can alternate between
MO2 and Modbench on the same instance, while fixing MO2's one UX wart — batch cleanup
actions are kept out of the per-row context menu.

The tab reads the per-archive `.meta` sidecar MO2 already writes: it derives each row's
Status from that file and, on a successful Install, writes the install state back to it —
so the loadout and the Downloads view stay consistent with MO2's own bookkeeping.

## User Stories

1. As a mod author curating a loadout, I want to open a Downloads tab showing the
   archives in my instance's `downloads/` folder, so that I can see everything I've
   fetched without leaving Modbench.
2. As a user, I want each archive shown as a single row with its filename, so that the
   list maps one-to-one to the files on disk.
3. As a user, I want the archive's `.meta` sidecar to *not* appear as its own row, so
   that the list isn't cluttered with bookkeeping files.
4. As a user, I want a Status column telling me whether an archive is Downloaded,
   Installed, or Removed, so that I can tell at a glance what I still need to install.
5. As a user, I want the archive's size shown, so that I can gauge how large a mod is.
6. As a user, I want the archive's file time shown, so that I know when I fetched it.
7. As a user, I want the list sorted newest-first by default, so that the mod I just
   downloaded is at the top.
8. As a user, I want to click any column header to re-sort by that column, so that I can
   group by Status or find a mod by name or size.
9. As a user, I want to right-click a row and Install that archive into my loadout, so
   that I can add a downloaded mod without re-picking the file from a dialog.
10. As a user, I want an archive's Status to flip to Installed immediately after I
    install it, so that the list reflects what I've done.
11. As a user, I want to Visit on Nexus from a row, so that I can open the mod's page to
    read about it or check for updates.
12. As a user, I want the Visit on Nexus action unavailable when the archive has no Nexus
    mod id, so that I'm not offered a link that can't work.
13. As a user, I want to Open File on a row, so that I can inspect the archive's contents
    in my system's archive tool.
14. As a user, I want to Open Meta File on a row, so that I can read or hand-edit the
    `.meta` sidecar when I need to.
15. As a user, I want Open Meta File unavailable when there's no sidecar, so that I'm not
    offered an action with nothing to open.
16. As a user, I want to Reveal in Explorer from a row, so that I can find the archive in
    my OS file manager.
17. As a user, I want to Delete an archive from a row, so that I can reclaim disk space.
18. As a user, I want Delete to remove both the archive and its `.meta` sidecar, so that
    I don't leave an orphaned metadata file behind.
19. As a user, I want Delete to move files to the system trash rather than erasing them,
    so that I can recover from a mistake.
20. As a user, I want Delete to ask for confirmation, so that I don't lose an archive by
    a stray click.
21. As a user, I want deleting an archive to leave the installed mod untouched, so that
    freeing download space never uninstalls anything.
22. As a user, I want to Hide an archive I don't want to see, so that I can declutter the
    list without deleting the file.
23. As a user, I want hidden archives filtered out of the list by default, so that hiding
    actually declutters.
24. As a user, I want a "Show hidden" tick box, so that I can bring hidden archives back
    into view when I need them.
25. As a user, I want hidden archives shown dimmed when "Show hidden" is on, so that I can
    tell them apart from visible ones.
26. As a user, I want to Unhide an archive while hidden ones are shown, so that I can undo
    a hide.
27. As a user, I want a Refresh button, so that I can force a re-scan of the folder if the
    list ever looks stale.
28. As a user, I want the list to update on its own as files change in `downloads/`, so
    that archives I drop into the folder appear without my doing anything.
29. As a user, I want to drop archive files into the `downloads/` folder from my OS file
    manager and have them show up in the tab, so that adding a manually-downloaded mod is
    frictionless.
30. As a user, I want a clear "no downloads yet" message when the folder is empty, so that
    I know the tab is working and just has nothing to show.
31. As a user, I want a clear message when the instance has no `downloads/` folder at all,
    so that I understand why the tab is empty and what's expected.
32. As a user opening the tab from the command palette (or a Mods-view toolbar button), I
    want a single obvious entry point, so that I can get to my downloads quickly.
33. As a user with a long downloads folder, I want to type a substring into a filter box and
    have the list narrow to matching archive names, so that I can find one without scrolling.

## Implementation Decisions

### Scope

- This spec covers the **Downloads tab surface only** — the editor-tab webview, its
  table, toolbar, row actions, and the live file view over `downloads/`.
- The `nxm://` protocol handler and Nexus API integration (issue #5) are **out of scope**
  — a download/protocol handler, not UI. When built it will populate the same
  `downloads/` folder this tab watches.
- Update checks (issue #6) are **out of scope** — a Mods-tab concern (you update an
  *installed* mod).
- Endorsements / mod tracking are **out of scope** — a Mods-tab concern.

### Downloads directory

- The tab views the MO2 instance's shared `downloads/` folder
  (`<instanceRoot>/downloads/`), per
  [modmanager ADR-0001](../../modbench/src/modmanager/docs/adr/0001-mo2-native-modlist-format.md).
  Not a Modbench-private location — a user must be able to alternate between MO2 and
  Modbench on the same instance with no divergence.
- Retention (keep vs. purge archives after install) is **not a Downloads-tab decision**:
  the tab only views files; it imposes no keep/purge policy.

### Row model & the `.meta` sidecar

- **One row per archive.** The `.meta` sidecar is suppressed as its own row and read as
  the data behind the archive's row.
- **Status is read from the `.meta`** (MVP), mirroring `downloadmanager.cpp`:
  - `installed=true` → **Installed**
  - `uninstalled=true` → **Removed**
  - neither flag → **Downloaded**
- ⚠️ **Terminology:** MO2's `.meta` key `removed=true` means **hidden** (the Hide action),
  which is a *different axis* from the **Removed** Status (`uninstalled=true`). This spec
  and the code use "hidden" for `removed=true` and "Removed" only for the
  `uninstalled=true` Status, and must never conflate the two.
- An archive with **no `.meta` sidecar** (e.g. a manually-dropped file) is a valid row:
  Status **Downloaded**, with Nexus/meta actions gated off (below).

### Columns

- MVP columns: **Name / Status / Size / Filetime**.
- **Name** = the raw archive filename (MO2 parity), e.g.
  `Sleep Or Save-12262-2-2-1540248406.zip`.
- Column headers are **sortable**; default sort is **Filetime descending** (newest first).
- Row selection is **single-row** in MVP.

### Toolbar

- **Refresh** — force a re-scan of `downloads/` (safety valve).
- **Filter** — a text box matching archive **Name** (raw filename) by case-insensitive
  substring; the table narrows live as the user types. No separator/grouping concept here
  (unlike the Mods tree's filter toggle) — Downloads is a flat list, so this is a plain
  substring match, applied after hidden-filtering. Every Modbench list surface gets this same
  filter box (Mods tree, Downloads, Plugin List) for consistency.
- **Show hidden** — a tick box; off by default. When on, hidden rows are shown **dimmed**.
- Batch cleanup buttons are **deferred** to a separate issue (see Out of Scope).

### Live updates

- A **file-watcher** on `downloads/` drives live updates: archives (and `.meta` changes)
  added, removed, or modified on disk are reflected without user action. Refresh remains
  as a manual fallback for filesystems where watch events are unreliable.

### Row context menu (per-item only)

Kept scoped to the clicked row — batch/category actions are deliberately **not** here
(MO2's conflation of the two in one dropdown is the UX wart being fixed).

- **Install** — reuse the existing `modbench.modList.installFromArchive` flow
  (extract → detect root → install into the loadout, stamping `installationFile` into the
  new mod's `meta.ini`), pre-supplied with this row's archive path (skipping the
  file-picker). On **success**, write `installed=true` back to the download's `.meta`, so
  the row's Status transitions Downloaded → Installed live. (The symmetric
  `uninstalled=true` write belongs to the Mods-tab uninstall path — out of scope here.)
- **Visit on Nexus** — open `https://www.nexusmods.com/{gameSlug}/mods/{modID}`, where
  `gameSlug` derives from the instance's game (the existing MO2 game-name → Nexus-slug
  mapping) and `modID` from the `.meta`. **Gated off** when there's no `modID`.
- **Open File** — OS-open the archive in the system's associated application.
- **Open Meta File** — open the `.meta` sidecar in the editor. **Gated off** when there's
  no sidecar.
- **Reveal in Explorer** — reveal the archive in the OS file manager.
- **Delete** — move **both** the archive and its `.meta` sidecar to the **system trash**
  (recoverable), behind a **confirmation** dialog. Removes files only; never uninstalls
  the mod that was installed from the archive.
- **Hide / Unhide** — Hide sets `removed=true` in the `.meta` (filtering the row out
  unless *Show hidden* is on); the action reads **Unhide** on an already-hidden row and
  clears the flag.

### Placement & entry point

- Editor-tab webview opened via a command (same mechanism as `modbench.openEditor`), with
  an entry point from the command palette and/or a Mods-view title-bar button. The
  ambient `↓ N downloading` status-bar item and MO2's inline green progress bar are
  **described here but deferred to #5** — nothing is mid-download in this MVP.

### Architecture / seams

- **A new pure `downloads` model module** is the primary seam. It takes a directory
  listing of `downloads/` plus each archive's `.meta` text and produces the render-ready
  rows (Name, Status, Size, Filetime, hidden flag, per-row action-enabled flags), already
  sorted and hidden-filtered. This mirrors the existing pure-logic layer
  (`statusChecker.ts`, `metaIni.ts`, `modlistText.ts`).
- The `.meta` **mutations** — Install writeback (`installed=true`) and Hide/Unhide
  (`removed=true/false`) — fold into this same module as surgical text transforms (the
  `modlistText.ts`/`metaIni.ts` pattern), so they exercise the **same seam**. Writes are
  surgical/byte-faithful, consistent with the rest of the MO2 adapter.
- A **thin VS Code adapter** (webview panel + file-watcher + command handlers) wires the
  model to the webview and performs the unavoidable VS Code calls (trash-delete,
  OS-open, reveal, and the Install hand-off). Install **delegates to the already-tested
  `installFromArchive`**; the other calls stay too thin to hold logic.

## Testing Decisions

- **Good tests here assert external behavior, not implementation details.** For the
  `downloads` model that means: given a directory listing + `.meta` contents, assert the
  produced rows (and their Status / hidden / action-enabled flags / order); given a
  `.meta` text + a mutation, assert the resulting text. No assertions about private
  helpers or call sequences.
- **Primary unit seam — the `downloads` model module** (Vitest, `npm run test:unit`, no
  backend). Cases to cover:
  - filename → row mapping; `.meta`-sidecar files suppressed as rows.
  - Status derivation: `installed=true` → Installed; `uninstalled=true` → Removed;
    neither / no-`.meta` → Downloaded.
  - hidden filtering: `removed=true` excluded by default; included (flagged hidden) under
    show-hidden.
  - name filter: case-insensitive substring match against Name; empty filter shows all rows.
  - default sort Filetime descending; header re-sort by each column.
  - action gating: no `modID` → Visit-on-Nexus disabled; no `.meta` → Open-Meta disabled.
  - mutations: Install writeback sets `installed=true`; Hide sets and Unhide clears
    `removed=true`, byte-faithfully.
- **Prior art:** `metaIni.test.ts`, `modlistText.test.ts`, `statusChecker.test.ts`,
  `modOrganizerIni.test.ts` — same fixture-in / value-out style; instance fixtures live
  under `modbench/src/modmanager/test/fixtures/`.
- **Reused integration seam** (`npm run test:integration`, real VS Code process) for
  opening the tab and the file-watcher reflecting a folder change. Row-action message
  dispatch is unit-tested instead (`DownloadsPanel.test.ts`, `npm run test:unit`) — no
  API exists to inject an inbound webview message into a real `WebviewPanel` from the
  integration harness, so `dispatchWebviewMessage`/`buildMessageHandlers` are extracted
  and exported as a directly-testable seam, `vscode` stubbed the way `ModListProvider.test.ts`
  does (see #71). The Install hand-off needs no new logic tests beyond that dispatch
  wiring — it delegates to the already-tested `installFromArchive`. Trash/open/reveal
  stay thin.
- Add the new command id(s) to `EXPECTED_COMMANDS` (per `modbench/CLAUDE.md`).

## Out of Scope

- **`nxm://` protocol handler + Nexus API integration** (issue #5) — populates the same
  `downloads/` folder later; can lift from `modorganizer/` source when built.
- **Update checks** (issue #6) and **endorsements / mod tracking** — Mods-tab concerns.
- **Batch cleanup actions** (Delete/Hide Installed / Uninstalled / All) — deferred to a
  separate "Batch downloads actions" design issue (#57); a multi-row selection model comes
  with it (MVP is single-select).
- **Friendly display name + a Version column** (#58) — the raw filename ships in MVP; a
  parsed friendly name and a Version column (sourced from the `.meta`) are high-value
  follow-ups.
- **In-webview drag-and-drop onto the tab** (#59) — the watcher + OS-drop-into-folder
  covers the essential case for MVP; doing in-webview DnD *properly* (resolving
  dropped-file paths, not streaming multi-GB archive bytes through the webview message
  channel) is its own chunk of work.
- **Meta-vs-reality Status validation** (#60) — MVP trusts the `.meta`. Correlating each
  download against the actually-present installed mods (via `installationFile`) to catch
  drift is a follow-up.
- The **status-bar item and in-progress/downloading state** — described above but
  implemented with #5.

## Further Notes

- MVP build tickets: #51 (lists archives, tracer) → #52 (file-watcher), #53 (Install with
  status writeback), #54 (navigational actions + gating), #55 (Delete to trash), #56
  (Hide/Unhide and Show-hidden), the latter five each blocked only by #51.
- Deferred follow-ups filed as their own tracker issues: #57 (batch actions), #58
  (friendly-name + Version column), #59 (in-webview DnD), #60 (meta-vs-reality validation).
- Consequence of ADR-0027: this surface's "editor-tab webview + status-bar item" shape is
  now resolved; the earlier `downloads.md` open questions (downloads directory,
  endorsements, retention) are all closed by the Implementation Decisions above.
