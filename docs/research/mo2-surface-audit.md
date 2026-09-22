# MO2 UI Surface Audit

An audit of what Mod Organizer 2's UI surfaces offer and what each gesture does, read from source.
It describes MO2 only and takes no position on any other tool.

## Sources and conventions

All paths are relative to `references/modorganizer/src/` (grep-only clone, never modified).
Citations are `file:line`. Abbreviations: `MLCM` = `modlistcontextmenu.cpp`, `MLVA` =
`modlistviewactions.cpp`, `MLV` = `modlistview.cpp`, `ML` = `modlist.cpp`, `PLCM` =
`pluginlistcontextmenu.cpp`, `PL` = `pluginlist.cpp`, `DLV` = `downloadlistview.cpp`, `DM` =
`downloadmanager.cpp`, `UI` = `mainwindow.ui`, `MW` = `mainwindow.cpp`.

**Verification status.** Everything is read from the source unless tagged **(inferred)**. Not in this
tree, so behaviour there is inferred from call sites: the `uibase` library (`DelayedFileWriter`,
`shellDelete`, `FilterWidget`, `setCustomizableColumns`), the game plugin that writes `plugins.txt`
and `loadorder.txt`, installer plugins (Quick/Manual/FOMOD dialogs), and Qt's own item-view
behaviour.

**Effect / Trigger / Argument** in the gesture tables: `writes` = changes a file, folder or list.
`reads` = changes only what is shown, or opens something (dialog, browser, Explorer). `runs` =
starts another program. Persistence is stated in Notes.

**Persistence shorthand.**
- `modlist.txt` writes are delayed: `Profile::writeModlist()` goes through `m_ModListWriter`
  (`profile.cpp:228-231`, constructed at `:78`), a `DelayedFileWriter` (uibase, delay
  **inferred**). It is flushed by `writeModlistNow` on refresh, run, install and profile switch
  (`organizercore.cpp:796,1282,1600,2018`).
- `modlist.txt` is written lowest-priority-last, so the top of the file is the highest priority.
  Prefix is `+` enabled, `-` disabled, `*` for foreign mods. Backups and Overwrite are never written
  (`profile.cpp:243-272`).
- `meta.ini` setters (`setCategory`, `setColor`, `setComments`, `ignoreUpdate`, ...) only set
  `m_MetaInfoChanged` (`modinforegular.cpp:446-680`). The file is written by `saveMeta()` at
  `modinforegular.cpp:249`, called from the destructor (`:64-70`), on Mod-Info-dialog open and close
  (`MLVA:592,611`), on Nexus responses (`:370-402`), and immediately by `markConverted` and
  `markValidated` (`:644-657`). Timing of the flush for the other setters is **inferred** (next
  `saveMeta` or when the `ModInfo` collection is rebuilt by `ModInfo::updateFromDisc`,
  `modinfo.cpp:233-241`).

---

## 1. Mod list (left pane)

### 1.1 Structure

Widget `ModListView` (`UI:385-447`), a `QTreeView` on `ModList`, via a sort proxy and an optional
grouping proxy (`MLV:773-792`, `updateGroupByProxy` `:659-700`).

| Aspect | Reading |
| --- | --- |
| Columns (order) | Mod Name, Conflicts, Flags, Content, Category, Author, Uploader, Nexus ID, Source Game, Version, Installation, Priority, Notes (`modlist.h:81-96`, captions `ML:1311-1343`) |
| Hidden by default | Content, Nexus ID, Uploader, Source Game, Installation, Notes (`MLV:818-826`); Name can never be hidden (`:840`) |
| Column show/hide | header context menu via `setCustomizableColumns` (`MLV:142`; uibase, body **inferred**) |
| Selection | `ExtendedSelection`, `SelectRows` (`UI:419-424`) |
| Edit triggers | `EditKeyPressed \| SelectedClicked` (`UI:401-403`): F2, or click an already-selected row (Qt behaviour, **inferred**) |
| Editable cells | Priority, Version, Nexus ID for any non-backup/overwrite row; Name and Notes for non-foreign rows (`ML:622-650`) |
| Default sort | Priority ascending (`MLV:777`) |
| Group by | combo "No groups / Categories / Nexus IDs" (`UI:549-560`); collapsible separators when sorted by priority and the setting is on (`MLV:665-673`) |
| Filters in the pane | text box (`UI:577`), separator filter combo "Filter/Show/Hide separators" (`filterlist.cpp:224-228`), category panel toggle (`UI:454`), "Clear all Filters" (`UI:505`) |
| Pane buttons | profile combo, list-options button (opens the global menu, `MW:368-369`), Open Folders menu (`MW:371`, `MW:2663-2691`), Restore Backup, Create Backup, active-mod counter (`UI:253-350`) |
| Copy | Ctrl+C copies the display names of selected rows; separators are wrapped in `[ ]` (`MLV:161-175`, `copyeventfilter.cpp:43`) |
| Marker highlights | selecting mods repaints conflict markers and highlights plugins (`MLV:462,731,1113`); display only |

### 1.2 Row types

| Type | Class | Check box | Draggable | In `modlist.txt` | Notes |
| --- | --- | --- | --- | --- | --- |
| Regular | `ModInfoRegular` | yes (`modinforegular.h:285`) | yes | `+`/`-` | |
| Separator | `ModInfoSeparator : ModInfoRegular` (`modinfoseparator.h:6`) | no (`canBeEnabled=false`, `:28`) | yes | `+`/`-name_separator` | folder is `<name>_separator`; display strips the suffix (`ML:107-122`) |
| Overwrite | `ModInfoOverwrite` | no | no (`hasAutomaticPriority`, `modinfo.h:660`) | no | `alwaysEnabled` (`modinfooverwrite.h:38`); priority column blank (`ML:214-219`) |
| Backup | `ModInfoBackup : ModInfoRegular` | no | no | no | `alwaysDisabled` (`modinfobackup.h:22`); sorted after all regular mods (`profile.cpp:412-421`) |
| Foreign (unmanaged/DLC) | `ModInfoForeign` | no (`canBeEnabled` default false) | yes | `*name` | `alwaysEnabled`; not editable by name (`ML:635-637`); shown only when the display-foreign setting is on (`modinfo.cpp:253-270`) |

### 1.3 Check box, drag and drop

| Item | Reading |
| --- | --- |
| Check box | `Qt::CheckStateRole` on column 0 only when `canBeEnabled` (`ML:269-274`). `setData` → `Profile::setModEnabled` (`ML:537-546`, `profile.cpp:616-637`) → `modStatusChanged` → directory-structure refresh + `modlist.txt` write (`organizercore.cpp:1724-1761`, `:122-125`) |
| Double click right after a check | ignored inside `doubleClickInterval` (`MLV:986-991`) |
| Drag source | rows whose model flags include `ItemIsDragEnabled`: everything except Overwrite and Backup (`ML:622-650`) |
| Drop targets | drop-enabled on separators; on any row when the payload is local files (`ML:641-649`, `onDragEnter` `:1103-1106`) |
| Payloads accepted | (a) mod rows, (b) a Downloads row, (c) external archive file, (d) external folder, (e) local files from an origin such as Overwrite (`ML:1137-1170`, `modlistdropinfo.cpp:98-124`) |
| Mod-row drop | `changeModPriority(rows, priority)` → `Profile::setModPriority` per mod → `modlist.txt` (`ML:666-723`, `profile.cpp:690-725`) |
| Download-row drop | queued `installDownload(row, priority)` (`MLV:830-836`) |
| External archive drop | queued `installArchive(path, priority)` (`MLV:837-843`) |
| External folder drop | input dialog "Copy Folder..." "Please enter the name", then `createMod` + `copyDir`, `refresh`, priority (`MLV:577-625`) |
| Local-file drop on a mod | `shellMove` of the files into that mod's folder, then `fileMoved` (`ML:1025-1101`); target must be a non-separator regular row (`ML:1108-1121`) |
| Drop refused | anything except local files when the sort column is not Priority (`modlistsortproxy.cpp:630-632`, message "Drag&Drop is only supported when sorting by priority" `:658-663`); Downloads drops under Category/Nexus-ID grouping (`:638-643`); separators dropped onto a mod, or a mod dropped into its own separator (`modlistbypriorityproxy.cpp:262-274`) |
| Drop position | dropping just below an expanded separator means "first inside" (`modlistbypriorityproxy.cpp:312-321`); auto-expand/collapse on hover after 750 ms (`MLV:143,1368-1417`) |
| Separator as drag payload | the row is moved by priority like any mod. Whether its children follow is **not visible in the code read** |

### 1.4 Selection and mouse

- Alt+click on a separator (collapsible mode) also selects or deselects all its children; editing is
  suppressed while Alt is held (`MLV:1421-1492`).
- Right click on the empty area shows the global menu; on a row shows the row menu
  (`MLV:963-980`).
- Right-click on an unselected row replaces the selection: Qt default, **inferred**. The menu then
  reads `selectionModel()->selectedRows()` if any selection exists, else the clicked row
  (`MLCM:227-231`).

### 1.5 Keyboard (`MLV:1494-1537`, only when a row is selected)

| Key | Action |
| --- | --- |
| Space | toggle enabled state of every selected row (`toggleSelectionState` `:650-656` → `ML:1445-1466`; **no filter** on row type, so a selected separator flips too, **inferred effect** on its `+`/`-` prefix) |
| Delete | `removeMods(selected)` (`:644-648`) |
| Ctrl+Enter | Open in Explorer, exactly one row selected |
| Ctrl+Up/Down | shift priority of the selection by 1, only when sorted by Priority; direction flips in descending order (`:627-642`, `ML:1393-1424`) |
| Shift+Enter | toggle expand of the separator; on a child row, collapse and select its parent |
| Ctrl+C | copy names (see 1.1) |
| F2 | rename in place (edit trigger) |

### 1.6 Double click (`MLV:982-1052`)

Ignored when the double click follows a check-box click. Otherwise: **Ctrl** → Open in Explorer;
**Shift** → visit Nexus, else custom URL (`MLVA:950-977`); **plain on a separator (collapsible
mode)** → toggle expand; **plain otherwise** → Information dialog, opened on the tab matching the
clicked column: Notes→Notes; Version, Nexus ID, Source Game→Nexus; Category→Categories;
Conflicts→Conflicts; else default.

### 1.7 Context menus

Legend for rows: R regular, S separator, O overwrite, B backup, F foreign. No item is disabled by
`setEnabled`; conditions only hide items, except the two "state unknown" entries
(`MLCM:563-566,591-594`). Multi-selection does **not** change which items are shown. The menu is
built from the **clicked** row's type and the handler then acts on all selected rows, except where
noted "index only" (the clicked row alone). Kind codes: `M` writes `meta.ini`, `L` writes
`modlist.txt`, `F` changes mod folders on disk, `X` opens an external app or dialog.

#### 1.7.1 Empty-area menu = "All Mods" submenu = list-options button menu

Class `ModListGlobalContextMenu` (`MLCM:12-104`). The same class is (1) the empty-area menu
(`MLV:970`), (2) the submenu "All Mods" at the top of every row menu (`MLCM:235-238`), (3) the
menu of the list-options button (`MW:368-369,2944`).

| Caption | Visible when | Handler | Kind |
| --- | --- | --- | --- |
| Install mod... / Install mod above... / below... / inside... | plain caption when opened without a row (empty area, button). Positional captions when opened from a row menu, sorted by Priority, row not a Backup: "above" ascending, "below" descending, "inside" on a separator (`MLCM:33-70`). **Backup row + priority sort: none of the three items appear** (the `else` branch is skipped, `:34-60`) | file dialog "Choose Mod" filtered to supported archive extensions, then `installMod(path, priority)` (`MLVA:87-111`) | `F` `L` `M`; installer dialogs (section 5) |
| Create empty mod (above/below/inside) | same rule | text dialog "Create Mod..." "This will create an empty mod. Please enter a name:"; error box if the name exists; `createMod` (mkdir + `meta.ini`, `organizercore.cpp:704-730`), `refresh`, `changeModPriority`, select (`MLVA:113-150`) | `F` `M` `L` |
| Create separator above / Create separator | same rule, "above" only | text dialog "Create Separator..."; appends `_separator`; `createMod`, priority, reuses previous separator colour (`MLVA:152-204`) | `F` `M` `L` |
| Collapse all / Expand all | only in collapsible-separator mode (`MLCM:72-76`) | `QTreeView::collapseAll` / `expandAll`; state persisted per profile in its ini (`MLV:186-200`) | display (plus profile ini) |
| Enable all / Disable all ("...matching mods" while a filter is active) | always | Yes/No box "Really enable %1 mod(s)?"; `setActive` over the visible rows (`MLVA:206-221`, `ML:1474-1485`) | `L` |
| Check for updates | always | Nexus API request for all mods, plus endorsement and tracking info; sets the "Update available" filter (`MLVA:223-262`). Logs a warning if not authenticated | `M` (async, via response handlers) |
| Auto assign categories | always | warning box with "Don't show this again" (writes a global setting) then, for every non-separator mod with a Nexus category mapping, **removes all existing categories** and sets the mapped one (`MLVA:264-302`) | `M` |
| Refresh | always | `OrganizerCore::refresh()`: flush pending `modlist.txt`, rescan mods folder, re-read `modlist.txt`, rebuild the virtual file tree (`organizercore.cpp:1278-1293`) | display (flushes pending writes) |
| Export to csv... | always | options dialog (rows: all / active / visible; 13 column check boxes) then a text viewer with Copy and Save As (`MLVA:337-538`, `savetextasdialog.cpp:30-49`); a file is written only at Save As | `X`; writes a user-chosen `.csv`/`.txt` |

#### 1.7.2 Row menu order (`MLCM:221-274`)

1. "All Mods" submenu (1.7.1).
2. If the clicked row has children (collapsible separator): Collapse all, Collapse others, Expand
   all (`:241-250`).
3. Type block (below).
4. **Information...** for every type except F; this is the menu's default (bold) action
   (`:267-273`).

#### 1.7.3 Regular mod block (R) (`MLCM:464-637`)

| Caption | Visible when | Handler | Kind |
| --- | --- | --- | --- |
| Change Categories | always | checkbox tree in a push-button sub-menu; applied on `aboutToHide`. One mod: replace. Several: other mods get only the categories that differ from the clicked mod's state (`setCategoriesIf`) (`MLCM:340-347`, `MLVA:1254-1282`) | `M` |
| Primary Category | always | radio list of the **clicked** mod's categories; applied on hide to selected mods that already have that category (`MLCM:349-357`, `MLVA:1284-1301`) | `M` |
| Change versioning scheme | `downgradeAvailable` | Yes/Cancel; tries schemes until installed < newest; else "Sorry" box (`MLVA:863-900`); index only | `M` |
| Force-check updates | `nexusId > 0` | Nexus query for selected (`MLVA:304-335`); skipped in offline mode | `M` |
| Un-ignore update / Ignore update | ignored / `updateAvailable \|\| downgradeAvailable` | `ignoreUpdate` (`MLVA:852-861`) | `M` |
| Enable selected / Disable selected | always | `setActive(selected)` (`ML:1474-1485`) | `L` |
| Send to... | only when sorted by Priority (`MLCM:503-506`) | see 1.7.6 | `L` |
| Rename Mod... | always | in-place edit; on commit `renameMod` renames the folder, rewrites the name in **every profile's** `modlist.txt`, refreshes the active profile and file tree (`ML:486-517`, `MW:2495-2497`, `profile.cpp:317-330`); index only | `F` `L` |
| Reinstall Mod | always | needs a recorded `installationFile`; otherwise an info box says old-MO installs cannot be reinstalled, or that the file is missing; otherwise `installMod(file, -1, reinstall=true, mod, name)` (`MLVA:1010-1039`); index only | `F` `M`, installer dialogs |
| Remove Mod... | always | see 1.7.7 | `F` `L` |
| Create Backup | always | `copyDir(mod, <mod>_backupN)` then `refresh` (`MLVA:1041-1051`, `installationmanager.cpp:361-374`); index only | `F` |
| Restore hidden files | `FLAG_HIDDEN_FILES` | confirm (one mod: OK/Cancel; several: Yes/No list), then un-hide via `FileRenamer` (`MLVA:1053-1139`; per-file rename is in `restoreHiddenFilesRecursive`, not read; `.mohidden` renaming **inferred**) | `F` |
| Select Color... / Reset Color | only when the clicked **column is Notes** (`MLCM:530-540`); Reset needs a set colour | `QColorDialog`; colour applied to all selected and remembered globally; reset also clears the remembered colour (`MLVA:1195-1233`) | `M` (+ global setting) |
| Un-Endorse / Endorse + Won't endorse / Endorse / "Endorsement state unknown" (disabled) | `nexusId > 0` and endorsement integration on; variant by `endorsedState` (`MLCM:542-568`) | login-gated Nexus toggle; "Won't endorse" is local only (`MLVA:1150-1170`, `modinforegular.cpp:604-635`) | `M` (+ remote state) |
| Remap Category (From Nexus) | `nexusId > 0` and (Nexus category known or install file set) | set primary category from the Nexus mapping (`MLVA:1172-1193`) | `M` |
| Start tracking / Stop tracking / "Tracked state unknown" (disabled) | `nexusId > 0` and tracking integration on | login-gated Nexus toggle (`MLVA:1141-1148`) | `M` (+ remote) |
| Ignore missing data | `FLAG_INVALID` | `markValidated(true)`, saved at once (`MLVA:842-850`) | `M` |
| Mark as converted/working | `FLAG_ALTERNATE_GAME` | `markConverted(true)`, saved at once (`MLVA:902-910`) | `M` |
| Visit on Nexus | `nexusId > 0` | open mod URL in the browser; more than 10 selected asks "Are you sure" (`MLVA:912-930,999-1008`) | `X` |
| Visit the uploader's profile | `uploaderUrl` set | open URL (`MLVA:979-997`) | `X` |
| Visit on <host> | a valid custom URL is set | open URL (`MLVA:932-948`) | `X` |
| Open in Explorer | always | `shell::Explore` each selected non-foreign row (`MLVA:1303-1311`) | `X` |
| Information... | always | see section 5 | `X` |

#### 1.7.4 Separator block (S) (`MLCM:381-409`)

Change Categories, Primary Category (same handlers as R); **Rename Separator...** (in-place, index
only); **Remove Separator...** (same `removeMods` handler as R); Send to... (only when sorted by
Priority); **Select Color...** (always, not gated by column) and Reset Color (colour set);
Information... Missing compared with R: Enable/Disable selected, Rename Mod, Reinstall, Create
Backup, updates, endorse/track, visit, Open in Explorer. A separator's colour is stored as a
`meta.ini` value like any mod's (`modinforegular.cpp:618-621`). Rename edits the display name; the
`_separator` suffix is re-appended (`ML:116-122`).

#### 1.7.5 Overwrite (O), Backup (B) and Foreign (F) blocks

| Row | Caption | Visible when | Handler | Kind |
| --- | --- | --- | --- | --- |
| O | Sync to Mods... | overwrite folder non-empty (`QDir::count() > 2`, `MLCM:362`) | `SyncOverwriteDialog`: file tree with a per-file destination combo; `apply` deletes the destination file and renames the source into `mods/<origin>/<path>` (`organizercore.cpp:1875-1885`, `syncoverwritedialog.cpp:133-176`) | `F` |
| O | Create Mod... | same | name dialog "This will move all files from overwrite into a new, regular mod", `createMod`, `moveOverwriteContentsTo` (`MLVA:1395-1425,1345-1393`) | `F` `M` |
| O | Move content to Mod... | same | list dialog "Select a mod..." of regular mods (not separator/foreign/overwrite), then move (`MLVA:1427-1466`) | `F` |
| O | Clear Overwrite... | same | OK/Cancel "About to recursively delete: <path>"; `shellDelete(list, true)` (`MLVA:1468-1499`; the recycle flag is the second argument, semantics in uibase **inferred**) | `F` |
| O | Open in Explorer | always | as R | `X` |
| O | Information... | always | non-modal `OverwriteInfoDialog` (file tree: Open, Rename, Delete, New Folder; `overwriteinfodialog.cpp:48-51,291-307`); on close refreshes the origin structure (`MLVA:570-590`) | `F` inside the dialog |
| B | Restore Backup | always | regex `(.*)_backup[0-9]*$`; if `mods/<name>` exists, Yes/No "This will replace the existing mod"; deletes it, renames the backup dir to `<name>`, refresh (`MLVA:1313-1343`); index only | `F` |
| B | Remove Backup... | always | `removeMods` (as R) | `F` |
| B | Ignore missing data / Mark as converted/working | as R flags | as R | `M` |
| B | Visit on Nexus / uploader / host, Open in Explorer | as R conditions | as R | `X` |
| B | Information... | always | as R | `X` |
| F | Send to... | only when sorted by Priority (`MLCM:411-416`) | see 1.7.6 | `L` |

Foreign rows have no Information item and nothing else. Delete key on Overwrite: `removeRows`
emits `clearOverwrite()` when the folder has content, which runs Clear Overwrite (`ML:1210-1216`,
`MLV:726-728`); with an empty overwrite it does nothing.

#### 1.7.6 Send to... submenu (`MLCM:285-338`)

Visible for R, S, F when sorted by Priority. All write `modlist.txt` via `changeModsPriority`.

| Caption | Visible when | Handler |
| --- | --- | --- |
| Lowest priority | always | `sendModsToTop` → `MinimumPriority` = 0 (`MLVA:639-642`) |
| Highest priority | always | `sendModsToBottom` → `MaximumPriority` (`:644-647`) |
| Priority... | always | integer dialog "Set Priority" 0..INT_MAX (`:649-659`) |
| Separator... | always | list dialog "Select a separator..."; lands at the end of that separator's block (`:661-729`) |
| First conflict | any selected mod has `FLAG_CONFLICT_MIXED` or `OVERWRITE` (`MLCM:327-331`) | lowest priority among mods it overwrites (`:731-752`) |
| Last conflict | any selected has `MIXED`, `OVERWRITTEN` or `REDUNDANT` (`:332-336`) | highest priority among mods that overwrite it (`:754-776`) |

#### 1.7.7 Remove flow (R, S, B)

`removeMods(selected)` (`MLVA:787-840`):
- **One row:** `ModList::removeRows` shows Yes/No "Are you sure you want to remove "%1"?"
  (`ML:1230-1236`), then `removeRowForce`: disable, `ModInfo::removeMod` → `shellDelete(path, true)`
  of `mods/<name>` (`modinfo.cpp:172-190`), immediate `writeModlist` (`ML:1173-1203`).
- **Several rows:** one Yes/No box "Remove the following mods?" listing up to 20 names; on Yes,
  `removeRowForce` for each with the downloads watcher suspended (`MLVA:791-829`). Rows that are
  not `isRegular` are skipped. Overwrite and Foreign are excluded, but Separators and Backups
  count as regular (`modinforegular.h:27`, inheritance `modinfoseparator.h:6`,
  `modinfobackup.h:6`), so they are removed too **(inferred from class hierarchy)**.

### 1.8 Gestures: Mod list

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Enable/disable mod(s) | writes | check box, menu, key | mod | key = Space on all selected; menu items Enable selected / Disable selected on R rows only; check box absent for S, O, B, F; `modlist.txt` delayed |
| Enable/disable all matching | writes | menu, dialog answer | mod (all visible) | confirm with count; matching = current filter |
| Reorder mod(s) by drag | writes | drag | mod, separator | Priority sort only; `modlist.txt`; separators and foreign rows draggable, Overwrite and Backup not |
| Reorder by keyboard | writes | key | mod, separator | Ctrl+Up/Down; Priority sort only |
| Send to lowest / highest / priority N / separator / first / last conflict | writes | menu, dialog answer | mod, separator | R, S, F rows; Priority... and Separator... use dialogs; conflict entries conditional |
| Edit Priority cell | writes | key, dialog answer | mod, separator | F2 opens the inline editor; values clamped by `setModPriority` (`profile.cpp:694-700`) |
| Rename mod / separator | writes | menu, key | mod, separator | F2 or menu; folder rename + every profile's `modlist.txt` |
| Edit Version / Nexus ID / Notes cell | writes | key, dialog answer | mod | inline editor; `meta.ini` (`ML:559-580`); Notes not for foreign |
| Create empty mod / separator | writes | menu, dialog answer | none | anchor row optional (position); text dialog |
| Install mod from archive | writes | menu, drag | none | menu here or toolbar/Ctrl+M (section 4); drag of an archive file; installer dialogs, section 5 |
| Install from Downloads row | writes | drag | downloaded file | dragged from the Downloads tab; refused under category/Nexus-ID grouping |
| Copy folder as new mod | writes | drag, dialog answer | none | external folder dropped; name dialog |
| Move local files into a mod | writes | drag | mod | files from an origin such as Overwrite; refused on separators |
| Remove mod / separator / backup | writes | menu, key, dialog answer | mod, separator | Delete key or menu; confirm dialogs 1.7.7 |
| Create Backup / Restore Backup | writes | menu | mod | index only |
| Reinstall | writes | menu | mod | uses recorded installation file |
| Restore hidden files | writes | menu | mod | conditional on hidden-file flag |
| Change / primary category, ignore update, colour, endorse, track, remap category, ignore missing data, mark converted, versioning scheme | writes | menu | mod, separator | `meta.ini`; endorse/track also call Nexus |
| Sync / Create Mod / Move content / Clear Overwrite | writes | menu, key | mod | Overwrite row only; Delete key = Clear Overwrite; conditional on non-empty Overwrite |
| Check for updates, Force-check updates | writes | menu | mod | network; `meta.ini` via responses; global item also sets a filter |
| Auto assign categories | writes | menu, dialog answer | mod | wipes categories of mapped mods |
| Refresh | reads | menu | none | flushes pending, rescans (F5 on toolbar) |
| Collapse / expand | reads | menu, key, double click | separator | Shift+Enter; per-profile ini |
| Select children of separator | reads | drag | separator | Alt+click; selection only |
| Open Information dialog | reads | menu, double click | mod, separator, backup | tab picked by clicked column; not for foreign |
| Open in Explorer | reads | menu, key, double click | mod, backup, overwrite | Ctrl+Enter, Ctrl+double click; external app; skipped for foreign |
| Visit Nexus / uploader / custom URL | reads | menu, double click | mod, backup | Shift+double click; external browser; >10 selected asks |
| Export CSV | reads | menu, dialog answer | none | Save As writes a user file |
| Copy names | reads | key | mod, separator | Ctrl+C; separators bracketed |
| Sort, filter, group, show/hide columns | reads | menu | none | header menu and filter widgets; display only |

Same object on other surfaces: a **mod** also appears as the origin of a plugin (section 2), as a
highlight when a plugin is selected, and in the Conflicts tab "Go to..." list (section 5). It is
**not** offered the mod-list menu on those surfaces (section 7).

---

## 2. Plugin list (right pane, "Plugins" tab)

### 2.1 Structure

Widget `PluginListView` (`UI:911-985`), a `QTreeView` on `PluginList` through `PluginListSortProxy`
(`pluginlistview.cpp:233-244`).

| Aspect | Reading |
| --- | --- |
| Columns | Name, Flags, Priority, Mod Index, Form Version, Header Version, Author, Description (`PL:87-108`, `pluginlist.h:92-101`) |
| Default sort | Priority ascending (`pluginlistview.cpp:243`) |
| Selection | `ExtendedSelection`, `SelectRows` (`UI:945-950`); drag-drop mode `InternalMove` (`UI:930-938`) |
| Filter | text box; OR with `\|`, `\|\|` or `OR`; AND by spaces; substring on the name (`pluginlistsortproxy.cpp:100-130`); an active filter puts a red border on the list (`pluginlistview.cpp:168-178`) |
| Buttons | Sort (LOOT), Restore backup, Create backup, active counter (`UI:810-870`) |
| Selection side effect | selecting plugins highlights their origin mods in the mod list and their masters in the list (`pluginlistview.cpp:264-284`); display only |

### 2.2 Check box, drag, lock

| Item | Reading |
| --- | --- |
| Check box | user-checkable unless force-loaded, force-enabled or force-disabled (`PL:1906-1925`). `setData` sets `enabled` (blueprint sibling toggled for games with blueprint plugins), `refreshLoadOrder`, then `writePluginsList` (`PL:1825-1870`) → delayed `savePluginList` (`organizercore.cpp:143,1974-1982`) → game plugin writes `plugins.txt`/`loadorder.txt` (**inferred**, `PL:802-810`) and `lockedorder.txt` (`PL:789-800`; name at `profile.cpp:958-961`) |
| Drag | allowed unless force-loaded or force-disabled; only when sorted by Priority or Mod Index; otherwise a message "Drag&Drop is only supported when sorting by priority or mod index" (`pluginlistsortproxy.cpp:105-112`, `PL:1906-1925`) |
| Move rules | plugins cannot go above their masters, masters not below their children, non-masters not above masters, blueprint plugins stay last, non-force-loaded not above primary plugins (`PL:1927-2045`) |
| Drop | `changePluginPriority` → `refreshLoadOrder` → `writePluginsList` (`PL:2047-2075`) |
| Lock | a locked plugin keeps its load-order slot; `refreshLoadOrder` re-applies locked slots after every change (`PL:920-962`); stored in `lockedorder.txt` (`PL:789-800`) |
| Sort | Sort button runs LOOT (`pluginlistview.cpp:180-215`): offline-mode confirm; saves the list first, locks the window, `runLoot`, refresh, save |
| Double click | ignored just after a check; single selected row whose origin is a regular or overwrite mod: Ctrl → Open in Explorer, else Information dialog of the origin mod (`pluginlistview.cpp:310-354`). Plugins from game files (no origin mod) do nothing |

### 2.3 Keyboard (`pluginlistview.cpp:382-413`)

Space toggles all selected (`PL:627-643`); Ctrl+Up/Down shifts priority when sorted by Priority or
Mod Index (`PL:604-625`); Ctrl+Enter opens the origin in Explorer (single row); Ctrl+C copies
names (`pluginlistview.cpp:33`).

### 2.4 Context menu (`PLCM:11-165`)

Right click anywhere in the list; the selection is the current selection, or the clicked row if
none (`PLCM:17-21`). No `setEnabled` use; only hiding.

| Caption | Visible when | Handler | Kind |
| --- | --- | --- | --- |
| Enable selected / Disable selected | at least one row selected | `setEnabled(selected, bool)`, skips force-loaded/enabled/disabled (`PL:528-559`) | writes plugin list |
| Enable all / Disable all | always | Yes/No "Really enable all plugins?"; `setEnabledAll` (`PL:561-589`) | writes plugin list |
| Send to... > Top / Bottom | selection non-empty | `sendToPriority(selected, 0 / INT_MAX)`, force-loaded skipped (`PL:591-602`) | writes |
| Send to... > Priority... | same | integer dialog "Set Priority" | writes |
| Unlock load order | selection has an enabled, locked plugin | `lockESPIndex(false)` per enabled plugin (`PLCM:130-137`, `PL:890-904`) | writes `lockedorder.txt` |
| Lock load order | selection has an enabled, unlocked plugin | `lockESPIndex(true)`; refused for force-loaded | writes `lockedorder.txt` |
| Open Origin in Explorer | clicked row has an origin mod (hidden for game files like `Skyrim.esm`, `PLCM:82-98`) | `shell::Explore` on each selected plugin's origin (`PLCM:139-150`) | external app |
| Open Origin Info... | origin is not foreign **and exactly one row** selected; default action | opens the mod's Information dialog for regular or overwrite origins (`PLCM:152-165`) | opens dialog |

### 2.5 Gestures: Plugin list

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Enable/disable plugin | writes | check box, menu, key | plugin | Space toggles selected; delayed write of plugin lists; force-loaded/enabled/disabled rows immune; blueprint pair toggled |
| Enable/disable all plugins | writes | menu, dialog answer | plugin (all) | confirm dialog |
| Reorder by drag | writes | drag | plugin | Priority or Mod Index sort only; move rules above |
| Reorder by keyboard | writes | key | plugin | Ctrl+Up/Down; same sort restriction |
| Send to top / bottom / priority | writes | menu, dialog answer | plugin | Priority... uses a dialog |
| Edit Priority cell | writes | key, dialog answer | plugin | F2 inline editor; column Priority editable (`PL:1918-1919`) |
| Lock / unlock load order | writes | menu | plugin | only enabled plugins |
| Sort with LOOT | runs | dialog answer | plugin (all) | Sort button click (no menu); launches LOOT (`loot.cpp`), then refresh and save; the offline-mode confirm is the dialog answer |
| Backup / restore plugin lists | writes | dialog answer | plugin (all) | Backup/Restore buttons; `plugins.txt`, `loadorder.txt`, `lockedorder.txt` copies with timestamp suffix (`MW:3841-3851`); restore uses a selection dialog |
| Open origin in Explorer | reads | menu, key, double click | plugin | Ctrl+Enter, Ctrl+double click; external app |
| Open origin Information | reads | menu, double click | plugin | single selection only for the menu item |
| Filter, sort columns | reads | menu | none | filter box and header; display only |
| Select plugin highlights mods | reads | automatic | plugin | display only |

Same object on other surfaces: a **plugin** is listed in the Mod Info dialog's "Optional Plugins"
tab (`modinfodialog.ui:318`); actions there were not read. A plugin's **origin mod** is the bridge
to the mod list, but the plugin menu offers only Explorer and Information, not the mod menu.

---

## 3. Downloads tab

### 3.1 Structure

`DownloadListView` (`UI:1373-1421`), `DownloadList` model, `DownloadsTab` (`downloadstab.cpp`).

| Aspect | Reading |
| --- | --- |
| Columns | Name, Status, Size, Filetime, Mod name, Version, Nexus ID, Source Game (`downloadlist.h:38-50`, `downloadlist.cpp:76-91`) |
| Hidden by default | Mod name, Version, Nexus ID, Source Game (`DLV:153-156`) |
| Default sort | column 1 (Status) descending (`DLV:132`); status sort tiebreaks by newest file time (`downloadlist.cpp:266-337`) |
| Header menu | right click on header: check box list of columns 1..N (`DLV:175-208`) |
| Selection | no `selectionMode` set on this view (`UI:1373-1421`); the menu acts on the row under the cursor, never a multi-selection; Qt default single selection **inferred** |
| Filter | text box (`UI:1452`), `FilterWidget` (uibase, match rule **inferred**) |
| Show hidden | check box "Hidden files" (`UI:1426`) → `setShowHidden` + `refreshList` (`MW:3818-3821`, `DM:366-370`) |
| Buttons | Refresh (`refreshList`), Query Info (`queryDownloadListInfo`) (`downloadstab.cpp:27-32`, `UI:1319,1349`) |
| Drag out | rows are drag-enabled; mime marks a download (`downloadlist.cpp:100-110`); dropping on the mod list installs (section 1.3) |
| Drop in | archives (supported extensions only) or URLs onto the tab are copied or moved into the downloads folder; a name clash asks Overwrite / Rename new file / Ignore file (`MW:3930-4032`) |
| Content | archives found in the downloads folder with a `.meta` sidecar; orphan `.meta` files are **deleted** on every refresh (`DM:377-486`, deletion `:405-419`) |

Enum `DownloadState` order (`downloadmanager.h:138-154`): STARTED, DOWNLOADING, CANCELING, PAUSING,
CANCELED, PAUSED, ERROR, FETCHING..., NOFETCH, READY, INSTALLED, UNINSTALLED. "Finished" means state
>= READY.

### 3.2 Row context menu (`DLV:216-328`)

Built from the row under the cursor; the bulk items show on empty space too.

| Caption | Visible when | Handler | Kind |
| --- | --- | --- | --- |
| Install | finished | `installDownload(row)` (`organizercore.cpp:878-914`) | writes (mod folder) |
| Query Info | finished and info incomplete (Nexus file/mod id 0, `DM:1480-1491`) | MD5 the file (cancelable progress dialog), Nexus lookup by hash (`DM:1171-1232`) | writes `.meta` (**inferred** from `nxmFileInfoFromMd5Available`), network |
| Visit on Nexus | finished and info complete | opens URL, else message "Nexus ID for this Mod is unknown" (`DM:1234-1259`) | external app |
| Visit the uploader's profile | same | opens URL or message (`DM:1261-1280`) | external app |
| Open File | finished | `shell::Open` file; falls back to opening the downloads folder (`DM:1282-1297`) | external app |
| Open Meta File | finished | opens `<file>.meta`; if missing, creates it by writing `removed=false`, then opens (`DM:1299-1325`) | writes `.meta` (sometimes), external app |
| Reveal in Explorer | finished, downloading, paused/error/pausing | `shell::Explore` on the file or `.unfinished` (`DM:1327-1345`) | external app |
| Delete... | finished; paused/error/pausing | task dialog "Are you sure you want to delete this download?" with [Move to the Recycle Bin] / Cancel, then `removeDownload(row, true)` (`DLV:377-392`, `DM:878-915,954-1000`) | writes (recycle) |
| Hide | finished, row not hidden | `.meta` `removed=true` (`DLV:394-398`, `DM:906-910`) | writes `.meta` |
| Un-Hide | finished, row hidden (reachable only with "Hidden files" on) | `.meta` `removed=false` (`DM:917-947`) | writes `.meta` |
| Cancel / Pause | downloading | `cancelDownload` / `pauseDownload` by id | writes (partial file) |
| Resume | paused/error/pausing | login-gated `resumeDownload` (`downloadstab.cpp:110-116`) | network |
| Delete Installed Downloads... | always | Yes/No warning "remove all installed downloads from this list and from disk", `removeDownload(-2,true)` (`DLV:461-470`) | writes |
| Delete Uninstalled Downloads... | always | same wording, `-3` (`DLV:472-481`) | writes |
| Delete All Downloads... | always | same wording for finished downloads, `-1` (`DLV:450-459`) | writes |
| Hide Installed... / Hide Uninstalled... / Hide All... | clicked row not hidden (or no row) | Yes/No "(but NOT from disk)"; `removeDownload(-2/-3/-1, false)` (`DLV:483-511`) | writes `.meta` |
| Un-Hide All... | clicked row is hidden | `restoreDownload(-1)` (no confirm) (`DLV:405-408`) | writes `.meta` |

### 3.3 Keys and double click (`DLV:164-173,330-360`)

| State | Enter/Return | Delete | Space | Double click |
| --- | --- | --- | --- | --- |
| finished | Install | Delete (task dialog) | none | Install |
| downloading | none | Cancel (no confirm) | Pause | none |
| paused/error/pausing | none | Delete | Resume | Resume |

Space on a downloading row calls `issuePause(event->key())`, passing the key code where a row index
is expected (`DLV:347`) **(oddity)**. Keys act on the current item, not the whole selection.

### 3.4 Gestures: Downloads

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Install download | writes | double click, key, menu, drag | downloaded file | Enter key; drag onto the mod list; installer dialogs; optional hide-after-install setting (`organizercore.cpp:905-911`) |
| Delete download | writes | menu, key, dialog answer | downloaded file | recycle bin; Delete key on a running download cancels instead |
| Delete installed / uninstalled / all | writes | menu, dialog answer | downloaded file (bulk) | confirm dialogs |
| Hide / Un-Hide one | writes | menu | downloaded file | `.meta` `removed` flag |
| Hide installed / uninstalled / all; Un-Hide all | writes | menu, dialog answer | downloaded file (bulk) | Un-Hide has no confirm |
| Show hidden | reads | check box | none | display only |
| Query Info (one) | writes | menu | downloaded file | hash + Nexus; `.meta` |
| Query Info (all incomplete) | writes | dialog answer | downloaded file (bulk) | button click; offline-mode prompt; confirm above 5 (`DM:487-516`, `downloadstab.cpp:94-108`) |
| Open meta file | reads | menu | downloaded file | may create it |
| Open file / Reveal in Explorer / Visit Nexus / Visit uploader | reads | menu | downloaded file | external apps |
| Cancel / Pause / Resume | writes | menu, key, double click | downloaded file | Space: pause/resume; Delete: cancel; double click resumes |
| Refresh list | reads | automatic | none | button click or folder change; see section 6; deletes orphan `.meta` |
| Filter, sort, choose columns | reads | menu, check box | none | header menu; display only |
| Drop archive/URL on tab | writes | drag | none | copy or move into downloads; clash dialog |

Same object elsewhere: a downloaded file's **installation file** name is recorded in a mod's
`meta.ini` and used by Reinstall (section 1); the mod menu has no "reveal download" action.

---

## 4. Toolbar, executables (run), profile selector, refresh, settings

### 4.1 Toolbar (`UI:1477-1512`)

Order: Manage Instances, Install Mod, Visit Nexus, Browse Mod Page (menu), Profiles, Refresh,
Executables, Tools (menu), Settings | Endorse ModOrganizer, Notifications, Update, Help. Pinned
executables are inserted before the trailing separator, object name prefix `custom__`
(`MW:755-795`). The same actions also live in the menu bar (`UI:1528-1571`).

| Action | Shortcut | Handler | Effect |
| --- | --- | --- | --- |
| Manage Instances... | none | instance manager dialog to switch or create an instance (`MW:3748`) | switches instance |
| Install Mod... | Ctrl+M | `modList->actions().installMod()` (`MW:2381-2384`) | as 1.7.1 |
| Visit Nexus | Ctrl+N | opens the game's Nexus page (`MW:2888-2896`) | external app |
| Browse Mod Page | none | menu built by `setupActionMenu` (`MW:715`) | not read |
| Profiles... | Ctrl+P | loops `ProfilesDialog` until a profile exists, refreshes the profile combo, applies local-saves/invalidation game features (`MW:2391-2425`) | see section 5 |
| Refresh | F5 | `OrganizerCore::refresh()` (`MW:2386,2580-2583`) | rescan mods and rebuild file tree |
| Executables... | Ctrl+E | `EditExecutablesDialog` (`MW:2427-2437`) | see section 5 |
| Tools | Ctrl+I | menu of tool plugins (`MW:434`); contents come from plugins | plugin-defined |
| Settings... | Ctrl+S | `SettingsDialog` tabs: General, Theme, Mod List, Paths, Nexus, Plugins, Workarounds, Diagnostics (`settingsdialog.ui:24,411,538,848,1058,1507,1748,2198`); on close re-applies path, foreign-display and archive-parsing changes (`MW:2741-2830`) | writes global settings ini |
| Endorse ModOrganizer / Notifications / Update / Help | Ctrl+H (Help) | network / dialogs | not read in depth |
| Toolbar context menu | none | on a pinned executable: "Remove '%1' from the toolbar" (unpins); elsewhere the toolbars menu (`MW:906-923`, `MW:3790-3815`) | unpin writes executables list |

### 4.2 Run box (top of the right pane)

- **Executable combo** (`UI:605`): item 0 opens the executables dialog and re-selects the previous
  item (`MW:2325-2344`).
- **Run** button (`UI:651`): `processRunner().setFromExecutable(exe).setWaitForCompletion(TriggerRefresh).run()`
  (`MW:2285-2304`). Before launching, `beforeRun` saves the profile: `modlist.txt`, `initweaks.ini`
  (merged ini tweaks of enabled mods), plugin lists, settings; waits for the directory structure;
  flushes; sets up the virtual file system mapping (`organizercore.cpp:1984-2036`,
  `createTweakedIniFile` `profile.cpp:300-310`). While the program runs the UI is locked with an
  unlock button unless locking is disabled; when it ends (or is force-unlocked) MO refreshes
  (`processrunner.cpp:806-835`). Effect: runs, then writes.
- **Shortcut** button (`UI:707`): menu "Toolbar and Menu / Desktop / Start Menu" toggles the
  shortcut of the selected executable; icons show add/remove state (`MW:358-364,2705-2739`).
- **Pinned executable** (toolbar or Run menu): `startExeAction` runs it the same way (`MW:1688-1720`).

### 4.3 Profile selector (`UI:253`, `MW:1733-1830`)

Combo: item 0 `<Manage...>` opens `ProfilesDialog`; other items are profiles. Choosing a profile
saves the current lists, then `setCurrentProfile` builds a new `Profile` (reads its `modlist.txt`),
stores the choice in settings, then `refresh` (`MW:1722-1731`, `organizercore.cpp:553-620`). The
combo ignores mouse-wheel changes (`MW:377-381`).

### 4.4 Pane buttons

| Button | Handler | Effect |
| --- | --- | --- |
| Refresh (via the list-options menu, and toolbar) | as 4.1 | reads |
| Open folders menu | Game, MyGames, INIs, Instance, Mods, Profile, Downloads, MO2 install/plugins/stylesheets/logs (`MW:2663-2691`) | external app |
| Create Backup (mods) | flush `modlist.txt`, copy to `modlist.txt.<timestamp>`; message "Backup of mod list created" (`MW:3918-3925`) | writes |
| Restore Backup (mods) | selection dialog of `modlist.txt.*`, `shellCopy` over `modlist.txt`, `refresh(false)` (`MW:3927-3939`, `queryRestore` `:3862-3895`) | writes |
| Create/Restore Backup (plugins) | as 2.5 | writes |

### 4.5 Gestures: Toolbar / run / profile / refresh / settings

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Run executable | runs | menu | executable | Run button, toolbar pin or Run menu; saves lists first; refreshes after exit |
| Run pinned executable | runs | menu | executable | toolbar or Run menu |
| Choose executable | reads | menu | executable | combo; changes selection only |
| Pin/unpin executable | writes | menu | executable | executables list; shortcut menu or toolbar context menu |
| Create/remove desktop or start-menu shortcut | writes | menu | executable | file outside the instance |
| Edit executables | writes | menu, key | executable | Ctrl+E; dialog, section 5 |
| Switch profile | writes | menu | profile | combo; saves old lists, loads new; writes settings |
| Manage profiles | writes | menu, key | profile | Ctrl+P; dialog, section 5 |
| Refresh | reads | menu, key, automatic | none | F5; flushes pending writes first; also runs after a program exits |
| Open settings | writes | menu, key | none | Ctrl+S; dialog answer applies; may need restart |
| Open folders | reads | menu | none | external app |
| Backup/restore mod list | writes | dialog answer | profile | button click; `modlist.txt.<ts>` |

Same object elsewhere: a **profile** is selectable only here; the mod list never offers profile
gestures. An **executable** is reachable from the toolbar, Run menu, run box, and the executables
dialog; the mod and plugin surfaces never start programs (Explorer and browser only).

---

## 5. Dialogs opened by gestures

| Dialog | Opened by | Content | Answer writes |
| --- | --- | --- | --- |
| Install file picker "Choose Mod" | Install mod..., toolbar, Ctrl+M | file dialog with `Mod Archive (*.ext ...)` filter, remembered directory (`MLVA:87-111`) | chosen path goes to the installer |
| Installer selection and dialogs | any install (menu, drag, Downloads, Reinstall) | `InstallationManager::install` opens the archive, then tries installer **plugins** in priority order (simple, custom, manual) (`installationmanager.cpp:624-882`). The Quick, Manual and FOMOD dialogs are installer plugins **not in this tree**. In this tree: errors "None of the available installer plugins were able to handle that archive" and "Something went wrong" | extracts into `mods/<name>/`, writes `meta.ini` (`:483-566`) |
| "Mod Exists" (`QueryOverwriteDialog`) | install (and `createMod`) when `mods/<name>` exists (`testOverwrite` `installationmanager.cpp:376-464`) | buttons Merge, Replace, Rename, Cancel; check box "Keep Backup" (`queryoverwritedialog.ui:100-131`). Merge = extract over existing; Replace = keep `meta.ini`, delete folder, recreate; Rename = "Mod Name" input then re-test; backup = `copyDir` to `<name>_backupN` first | folders, `meta.ini` |
| Nexus category unmapped | install of a download whose category has no mapping (`installationmanager.cpp:745-770`) | Proceed / Disable / Stop & Configure | setting |
| "Configure Mod" | install of a mod with `INI Tweaks` (`organizercore.cpp:835-843`) | Yes/No, then Information dialog on the INI Files tab | none |
| "Another installation is currently in progress" | second install while one runs (`organizercore.cpp:788-793`) | info box | none |
| Mod Information (`ModInfoDialog`) | Information..., double click, Origin Info | modal; tabs Text Files, INI Files, Images, Optional Plugins, Conflicts (General/Advanced), Categories, Nexus Info, Notes, Filetree (`modinfodialog.ui`). `saveMeta` on open and close; structure refreshed afterwards (`MLVA:592-636`) | `meta.ini`, files inside the mod (per tab, not read) |
| Conflicts tab context menu | inside Mod Information | Open/Execute, Preview, Execute with VFS, **Go to...** (opens the other mod's dialog), Open in Explorer, Hide (`modinfodialogconflicts.cpp:265-350,441-458`) | Hide renames files (`hideItems`) |
| Overwrite dialog | Information... on Overwrite | non-modal file tree with Open, Rename, New Folder, Delete (multi-file confirm "Are you sure you want to delete the selected files?") (`overwriteinfodialog.cpp:48-51,131-210`) | files in Overwrite |
| Name prompts | Create empty mod / separator, Create Mod (from Overwrite), Copy Folder | `QInputDialog` text; error box "A mod with this name already exists" / "A separator with this name already exists" (`MLVA:113-204,1395-1425`) | new folder |
| Set Priority | Send to > Priority... (mods and plugins) | integer dialog (`MLVA:649-659`, `PLCM:118-128`) | priority |
| Select a separator / Select a mod | Send to > Separator..., Move content to Mod... | list dialog (`MLVA:661-690,1440-1465`) | priority / files |
| Sync Overwrite | Sync to Mods... | tree with per-file mod combo | files |
| Delete confirmations | see 1.7.7, 3.2, plugin Enable/Disable all, Clear Overwrite | Yes/No or OK/Cancel; downloads use a recycle-bin task dialog (`DLV:377-392`) | deletion |
| Profiles dialog | Profiles..., `<Manage...>`, Ctrl+P | list of profiles with Create, Copy, Rename, Remove, Transfer Saves, Select, Close; check boxes "Use profile-specific Save Games", "Use profile-specific Game INI Files", "Automatic Archive Invalidation" (`profilesdialog.ui`) | see below |
| New profile input | Create | name plus check box "Default Game INI Settings" (`profileinputdialog.ui:20-36`) | new profile folder |
| Executables dialog | Executables..., combo item 0, Ctrl+E | Add, Remove, Up, Down, Reset ("This will restore all the executables provided by the game plugin..."); fields Title, Binary, Start in, Arguments, Overwrite Steam AppID, Create files in mod instead of overwrite, Force load libraries, shortcut icon, minimize to tray; OK/Apply/Cancel (`editexecutablesdialog.ui`, `.cpp:456-880`). Grey entries are plugin-provided and not editable | executables list (in settings) on OK/Apply |
| Open-links confirm | Visit ... on more than 10 mods (`MLVA:999-1008`) | Yes/No | none |
| Assign categories warning | Auto assign categories (`MLVA:264-280`) | Yes/Cancel, "Don't show this again" | setting |
| Restore backup choice | Restore Backup buttons | selection dialog (`MW:3862-3895`) | file copy |

Profile dialog behaviour (`profilesdialog.cpp`): **Select** (or double click / Enter on a row)
returns that profile and closes (`:129-141,389-392`); **Create** creates a profile folder
(`:195-208`); **Copy** asks a name and clones files (`:210-229`, `Profile::createPtrFrom`);
**Remove** refuses the active profile, Yes/No warning "...including profile-specific save games",
`shellDelete` then plain delete fallback (`:231-280`); **Rename** refuses the active profile
(`:282-313`); **Transfer Saves** opens a transfer dialog (`:407-413`); check boxes change
per-profile settings immediately (`:315-425`).

### 5.1 Gestures: Dialogs

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Answer Mod Exists: Merge / Replace / Rename / Cancel (+ keep backup) | writes | dialog answer | mod | Replace deletes the folder; backup folder created if checked |
| Confirm remove (mod, separator, backup) | writes | dialog answer | mod, separator | recycle bin |
| Confirm Clear Overwrite | writes | dialog answer | mod | Overwrite row; recycle bin |
| Confirm Enable all / Disable all (mods, plugins) | writes | dialog answer | mod, plugin | |
| Confirm delete download / bulk delete | writes | dialog answer | downloaded file | |
| Confirm Restore Backup (mod) | writes | dialog answer | mod | replaces existing mod |
| Profile Create / Copy / Rename / Remove / Select | writes | dialog answer, double click, key | profile | double click or Enter selects; active profile cannot be renamed or removed |
| Profile check boxes (saves, INIs, invalidation) | writes | check box | profile | immediate |
| Executable Add / Remove / Reorder / Reset / Edit fields | writes | dialog answer | executable | OK/Apply; plugin-provided ones read-only |
| Conflicts tab: Open / Preview / Explorer / Go to | reads | menu | mod | file inside the mod; Go to opens the other mod's dialog |
| Conflicts tab: Hide | writes | menu | mod | renames files inside the mod |
| Overwrite dialog: Delete / Rename / New Folder | writes | menu, key, dialog answer | mod | Overwrite row's files |

---

## 6. Refresh on disk change

- **No file watcher on the mods folder, on `modlist.txt`, `plugins.txt` or `meta.ini` was found.**
  The only `QFileSystemWatcher` uses are the downloads folder (`DM:166-208,283-285,363`, suspended
  by a RAII guard during MO's own writes), the saves folder (`savestab.cpp:21-27`) and the style
  sheet (`moapplication.cpp:153`).
- A change in the downloads folder triggers `refreshList` automatically (`DM:283-285`).
- For mods and profile files MO2 re-reads only on an explicit or implicit `refresh()` (menu Refresh,
  F5, profile switch, after install/create/remove/backup, after a launched program exits): flush
  pending `modlist.txt`, `ModInfo::updateFromDisc` rebuilds every mod from folders and `meta.ini`,
  then `Profile::refreshModStatus` re-reads `modlist.txt` (`organizercore.cpp:1278-1293`,
  `profile.cpp:391-470`). The refresh button's whatsThis says it is "usually not necessary unless
  you modified data outside the program" (`UI:283-295`).
- Pending in-memory `modlist.txt` and `meta.ini` writes happen before or during that re-read, so an
  outside edit made while a delayed write is pending can be overwritten **(inferred from
  `writeModlistNow(true)` at `profile.cpp:425`, not exercised)**.

---

## 7. Object x surface

Cell = gestures offered there (`-` = none). "Row menu" = context menu on that object's row;
"Keys/mouse" = keyboard, drag, double click.

| Object | Mod list: row menu | Mod list: keys/mouse | Plugin list | Downloads tab | Toolbar / run box | Dialogs (Profiles, Executables, Mod Info, Overwrite) |
| --- | --- | --- | --- | --- | --- | --- |
| Mod (R) | full R block (1.7.3) | check box, Space, Delete, F2, Ctrl+Up/Down, Ctrl+Enter, Ctrl+C, drag (reorder, receive files/archives), double click (Info / Explorer / Nexus) | origin of a plugin: Open Origin in Explorer, Open Origin Info..., double click, Ctrl+double click; highlighted when its plugins are selected | install target only (drop a download on it); Reinstall uses its recorded archive | Install Mod..., Refresh; no per-mod gesture | Mod Info (tabs); Conflicts tab lists other mods with **Go to...**, not the mod menu |
| Separator (S) | Change/Primary Categories, Rename, Remove, Send to, Select/Reset Color, Information | Space (**inferred** effect), Delete, F2, drag (reorder; receives drops as "inside"), double click expands, Shift+Enter, Alt+click selects children | - | - | - | Mod Info dialog (tabs not read) |
| Overwrite | Sync, Create Mod, Move content, Clear, Open in Explorer, Information | Delete (= Clear), Ctrl+Enter, double click; not checkable, not draggable | files created by a run appear as an origin for plugins; menu offers Explorer + Info | - | - | Overwrite dialog (Open, Rename, New Folder, Delete); Sync dialog |
| Backup | Restore, Remove, Ignore missing data, Mark converted, visit, Explorer, Information | Delete; not checkable, not draggable | - | - | - | Mod Info |
| Foreign | Send to only | drag (reorder); no check box; name not editable | origin of plugins; Explorer item shows only if the origin resolves to a mod (game files do not) | - | - | - |
| Plugin | - | - | full menu (2.4), check box, drag, Space, Ctrl+Up/Down, Ctrl+Enter, double click | - | Sort (LOOT), Backup/Restore buttons | Mod Info "Optional Plugins" tab (not read) |
| Downloaded file | - | drag source onto the mod list (install) | - | full menu (3.2), keys, double click, drag out | - (Refresh, Query Info, Hidden files apply to the list) | installer dialogs (as installation source) |
| Profile | - | - | - | - | profile combo, Profiles..., Backup/Restore mod list | Profiles dialog (Create, Copy, Rename, Remove, Select, Transfer Saves, check boxes) |
| Executable | - | - | - | - | run box (combo, Run, Shortcut), Run menu, toolbar pins, Executables... | Executables dialog |

**Same object on several surfaces, same gestures?**
- Mod: the mod-list menu (35+ items) is offered only on the mod list. From the plugin list the
  reduced set is Open Origin in Explorer and Open Origin Info.... From the Conflicts tab it is Go
  to... (open that mod's Information). Selecting a plugin or a mod cross-highlights; no gesture.
- Plugin: Enable/Disable, Send to and Lock exist only on the plugin list. Enable-all and
  Disable-all carry a confirm dialog on both the plugin list and the mod list.
- Downloaded file: Install by menu, key, double click or drag onto the mod list; Delete and Hide by
  menu only (Delete also by key).

---

## Surprises and oddities (read, not judged)

- The mod-list row menu is chosen by the clicked row's type but acts on the whole selection; items
  marked "index only" (Rename, Reinstall, Create Backup, versioning, Restore Backup, Information)
  ignore the rest of the selection (`MLCM:269-273,508-519`).
- Select Color appears for a regular mod only if the click landed in the Notes column
  (`MLCM:530-540`), but always for a separator (`:398-406`).
- A Backup row with a priority sort shows none of Install / Create empty / Create separator inside
  "All Mods" (`MLCM:34-60`).
- `removeMods` counts Separators and Backups as regular through inheritance; Overwrite and Foreign
  are the only exclusions.
- Multi-select remove asks once for the whole list; single remove asks per mod through
  `ModList::removeRows`; Delete on an Overwrite row runs Clear Overwrite (`ML:1210-1216`).
- Downloads Space-to-pause passes `event->key()` where a row index is expected (`DLV:347`).
- Refreshing the downloads list deletes orphaned `.meta` files without asking (`DM:405-419`).
- Most `meta.ini` setters only mark the mod dirty; the file is written later by `saveMeta`
  (destructor or dialog), not per gesture.
- Downloads `queryInfo(int)` is wired (`downloadstab.cpp:34`) and the view has `issueQueryInfo`
  (`DLV:367-370`), but the menu only calls the MD5 variant (`DLV:236`).
- The list-options button's `whatsThis` says "Refresh list" but its menu is the full All Mods menu
  (`UI:283-300`, `MW:368-369`).
