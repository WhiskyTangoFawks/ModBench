# xEdit Surface Audit — everything except the View grid

Describes xEdit only, read from source; takes no position on mEdit. The right-pane View grid (`vstView`, `pmuView`) is audited in [xedit-ux-audit.md](xedit-ux-audit.md) and not repeated here.

## Sources and conventions

Paths relative to `references/TES5Edit/xEdit/` (grep-only clone, never modified). `xeMainForm.dfm` = `.dfm`, `xeMainForm.pas` = `.pas`.

- **Read** = cited file:line. **Inferred** = marked *(inferred)*; used only for VirtualTreeView / VCL framework behaviour, since `External/VirtualTrees/` is not cloned.
- Menu visibility is decided in the popup handler, never by greying: `pmuNavPopup` (`.pas:15403`) sets `.Visible`; no nav item is ever set `.Enabled := False`. "Condition" below therefore means the `Visible` rule. Key accelerators re-run the popup handler and click the item only if visible (`.pas:20397-20420`), so a key is exactly as available as its menu item.
- Common gates in every write path: `wbEditAllowed`, `not wbTranslationMode` (translation mode hides every edit item), and `EditWarn` (`.pas:6060`), a one-time modal "Time to think..." dialog (`xeEditWarningForm.dfm:6`) skipped if `wbIKnowWhatImDoing`. These are abbreviated **gate** below.
- Gesture table `Effect`: `writes` = changes a plugin/file/record (in memory unless noted; saved only via Ctrl+S / exit); `reads` = changes only what is shown, or opens something.

## Layout

| Region | Control | Source |
| --- | --- | --- |
| Left | `vstNav` tree + FormID / EditorID search boxes + filename filter (`pnlSearch`, `pnlNavBottom`) | `.dfm:2093-2300` |
| Right, tabbed | `pgMain`: View, Referenced By, Messages, Information, three spreadsheet tabs, What's New | `.dfm:67-1356` |
| Top bar | `bnMainMenu` (hamburger, `pmuMain`), back / forward buttons, path box `lblPath`, link buttons `pnlBtn` (`pmuBtnMenu`) | `.dfm:1363-2092` |

The tab strip itself is hidden for most tabs: View, Referenced By and the spreadsheets are shown by code (`.pas:5141-5144`, `4823`, `16800`, `21217`).

---

## 1. Left navigator (`vstNav`)

### 1.1 Node kinds

`vstNavGetText` (`.pas:19963`) switches on `Element.ElementType`:

| Kind | `ElementType` | Col 0 / 1 / 2 | Children |
| --- | --- | --- | --- |
| Plugin / file | `etFile` | file name / header flags (`<ESM>`, `<Localized>`...) if `wbShowFileFlags` / CRC32 (`.pas:20024-20047`) | groups + file-header record |
| Group | `etGroupRecord` | short name / — / child count if `wbShowGroupRecordCount` (`.pas:19975-19984`) | records, or sub-groups |
| Record | `etMainRecord` | `LoadOrderFormID` (or "File Header" for TES4) / EditorID / display name (`.pas:19985-19999`) | its child group (CELL, WRLD, DIAL) |
| Chapter | `etStructChapter` | name / type / chapter name (`.pas:20000-20010`) | branch containers (non-FO4 record kinds; not further audited) |
| Child | records inside a "parented" group (`ParentedGroupRecordType`) | as record | A record's child group is folded up into the record's own node: the group node is hidden and its contents become the record's children (`.pas:20185-20330`, `InitNode`). |

Header column captions change with the focused kind (`vstNavChange`, `.pas:19714-19733`): file → Flags / CRC32; group → — / Child Count; chapter → Type / Name; else EditorID / Name.

Painting (`vstNavPaintText`, `.pas:20545-20610`): bold = `Element.Modified`; italic = injected; strike-out = not reachable; underline = references injected; colour = conflict state (`ConflictThisToColor`). Sort: single column header click toggles asc/desc (`vstNavHeaderClick`, `.pas:20061`); "Files" sort mode comes from `pmuNavHeaderPopup` (§1.4).

### 1.2 Selection, mouse, keyboard

Config: `.dfm:2125-2185`. SelectionOptions `[toFullRowSelect, toLevelSelectConstraint, toMultiSelect, toRightClickSelect]` (`.dfm:2151`); MiscOptions include `toToggleOnDblClick`; `DragOperations = [doCopy]`; `IncrementalSearch = isVisibleOnly`; `toAutoFreeOnCollapse` set.

- **Multi-select**: yes. `toLevelSelectConstraint` restricts a selection to one tree level *(inferred, framework)* — which is why every multi-record menu item below can assume same-parent nodes.
- **Selection drives the right pane automatically**: `vstNavChange` → `TryViewOrCompareSelectedRecords` (`.pas:19698`, `20493`). One record → View tab shows it. A file → shows its first record. Other container → shows its container. **2 up to `wbAutoCompareSelectedLimit` selected records** → View compares them side-by-side with no menu action (`.pas:20505`). Ctrl held while `ComparingSiblings` also compares (`.pas:20505`). Skipped while the View is pinned (`IsPinned`, `bnPinned`).
- **Click**: no `OnClick` handler; focus and selection only (framework).
- **Double click**: no `OnDblClick` handler; `toToggleOnDblClick` = expand/collapse *(inferred, framework)*. Alt while expanding = full recursive expand (`vstNavExpanding`, `.pas:19932`; `EditTips.txt:39`).
- **Right click**: selects the node (`toRightClickSelect`) and opens `pmuNav`. Menu is assigned only after load completes (`.pas:21443`) and removed during Compare-to reload (`.pas:3615`, `3673`), so it does not exist while the loader runs (`EditTips.txt:7`).
- **Drag**: `vstNavDragAllowed` (`.pas:21574`) allows dragging only nodes whose element is a main record. `vstNavDragOver` (`.pas:21587`) accepts nothing: the nav tree is a drag source only. The drop target is the View grid: `GetSourceElement` accepts `vstNav` as a source, builds a single element or `wbMultipleElements` (`.pas:7138-7165`), and `vstViewDragOver` / `vstViewDragDrop` (`.pas:18706-18740`) assign it into a field if `CanAssign` (a reference field taking a record, or a list taking entries). So dragging a navigator record onto a View cell is a write.
- **Keys** (`vstNavKeyDown`, `.pas:20387`; only when `wbLoaderDone`):

| Key | Action |
| --- | --- |
| Delete | click `mniNavRemove` if visible |
| Insert | if `mniNavAdd` visible: one entry → click it; several → `pmuNavAdd.Popup` at the row (see 1.5, surprise) |
| F2 | click `mniNavChangeFormID` if visible |
| Ctrl+M | `mniNavCreateModGroupClick` if visible |
| Ctrl+C | clipboard: per selected node, one line: record = column-0 text (Alt = record `Name`); file = file name (Alt = CRC32); chapter = column-0 (Alt = chapter name) (`.pas:20423-20473`) |
| `?` | focus the filename filter box (`vstNavKeyPress`, `.pas:20485`) |
| Alt+Arrow (form-level) | moves nav selection (Up/Down = prev/next visible, Left = parent+collapse, Right = expand+first child) while keeping the View's focused column/row (`FormKeyDown`, `.pas:6791-6880`) |
| Ctrl+S / Ctrl+O (form-level) | Save changed files dialog; Options (`.pas:6802-6807`) |

Other arrows, Home/End, type-to-search: framework; type-ahead limited to visible nodes (`isVisibleOnly`, `.dfm:2135`) *(inferred)*.

`EditTips.txt` keys with **no handler in `xeMainForm.pas`** (grep for `Bookmark`, `VK_F5`, `VK_F3` finds nothing there): Ctrl+1..5 / Alt+1..5 bookmarks (`EditTips.txt:21`), F5 save-over-original (`:15`), Ctrl+F3 Assets Browser (`:53`), Alt+F3 Worldspace Browser (`:54`), Ctrl+W weather editor (`:55`). Documented in `.dfm:639-645` help text but not implemented in the files read; treat as unverified here (may live in a unit not in this clone).

### 1.3 `pmuNav` — every item

Order as in `.dfm:2336-2710`. Visibility from `pmuNavPopup` (`.pas:15403-15669`). "Element" = the focused node's element. `gate` as defined above. `File` = focused node is `etFile`. `Selection editable/removable` = `EditableSelection` / `RemovableSelection` (`.pas:15975`, `16042`): selected nodes filtered by `IsEditable` / `IsRemovable`.

**Compare and filter (display only, except Compare to)**

| Caption | Visible when | Handler effect |
| --- | --- | --- |
| Compare to... | File | Open-file dialog (`odModule`); copies the chosen file into Data under a unique temp name, loads it as an extra module beside this one, resets filter (`.pas:3563-3623`). Adds a loaded module; changes no existing plugin. |
| Create delta patch using... | File, not translation mode | Open-file dialog, then creates a new patch plugin of differences (`.pas:3625`); refuses non-plugins. Creates a new file. |
| Compare Selected (n) | focused is a main record and all selected nodes are main records of the same signature, n>1 (`.pas:15570-15595`) | View pane compares those records (`DoSetActiveRecord`, `.pas:3543`). Display only. |
| Remove Filter | always | `ReInitTree` (`.pas:12549`): rebuilds the tree unfiltered. |
| Apply Filter | always | Opens **Filter...** dialog (§6), then prunes the tree (`.pas:13470-13540`). Display only. |
| Apply Filter to show Conflicts | always | Preset filter, no dialog (`.pas:14363`). Display only. |
| Apply Filter for Cleaning | `wbManualCleaningAllow` | Preset filter (`.pas:14435`). Display only. |
| Apply Filter for Cleaning (obsolete twin) | not `wbManualCleaningAllow` and not `wbManualCleaningHide` | Calls `mniNavCleaningObsoleteClick` (`.pas:3526`), an explanatory stub *(name-based; body not traced)*. |
| ...(selected files only) ×3 | same rules as above | Same filters but asks which files via `TfrmFileSelect` (`.pas:13980`). |

**Checks (read-only analysis, output in Messages)**

| Caption | Visible when | Effect |
| --- | --- | --- |
| Check for Errors | gate and any element | `PerformLongAction`, walks selection, reports to Messages (`.pas:3492`). |
| Check for Circular Leveled Lists | same | Same, for LVLI/LVLN cycles (`.pas:3460`). |
| BOSS/LOOT Cleaning Report | same and LOOT info loaded | Reports LOOT dirty info to Messages (`.pas:12274`). |

**Record-identity edits (write)**

| Caption | Visible when | Effect |
| --- | --- | --- |
| Change FormID | gate, record, not TES4, `IsEditable` | `InputQuery` for the new FormID (blank = generate + confirm); or with >1 selected / Shift, target-file `TfrmModuleSelect` renumber; rewrites the record's FormID and every referencer (`.pas:10153-10260`). Writes. |
| Change Referencing Records | gate, record with `ReferencedByCount>0` | Repoints all referencers to another FormID (`.pas:3316`). Writes to referencing records. |
| Renumber FormIDs from... | gate, File, editable | Renumbers all records in the file from a start ID (`.pas:12987`). Writes. |
| Compact FormIDs for ESL | as above and game supports light plugins and file not light/update | Same handler. Writes. |
| Inject Forms into master... | as above and file has masters | Same handler. Writes. |
| Batch Change Referencing Records | gate and File | Batch form of Change Referencing (`.pas:9774`). Writes. |

**Cleaning (write)**

| Caption | Visible when | Effect |
| --- | --- | --- |
| Undelete and Disable References | `wbManualCleaningAllow` and gate | Rewrites deleted REFRs as disabled (`.pas:11736`). Writes. |
| Remove "Identical to Master" records | same | Removes records equal to master (`.pas:12066`). Writes. |
| (obsolete twins) | as above | `mniNavCleaningObsoleteClick` stub. |
| Set VWD for all REFR with VWD Mesh in this file / ...as Override into.... | Oblivion only | Sets a flag on many REFRs (`.pas:11098`, `11204`). Writes. |
| Temporary / Persistent | never visible (`.pas:15540-15541`) | `mniNavCellChild`. Dead. |
| not Visible When Distant / Visible When Distant | gate and selection is only REFRs (checked reflects selection) | Toggles VWD on selected REFRs (`.pas:10049`). Writes. |

**Structure, add, remove (write)**

| Caption | Visible when | Effect |
| --- | --- | --- |
| Create New File... | always | `AddNewFileWithDialog` (`.pas:3280`): `TfrmModuleSelect` asks which module template ("What type of module do you want to create?"), creates a new empty plugin. Writes (new file). |
| Add > (entries) | gate, element is a container, `IsElementEditable`; entries from `Container.GetAddList` (`.pas:15522-15545`), split into "More..." submenus every 30 | `Container.Add(caption)` under the focused node: a group offers record types, a file offers groups; then focuses the new element and shows it (`.pas:9643-9688`). Shift on a group asks "How many:" (`InputQuery`) and adds N silently. Writes. |
| Remove | gate and any selected node `IsRemovable` | Confirmation `MessageDlg` (warning wording if it has children), removes records and their child groups (`.pas:11004-11060`). Writes. |
| Mark Modified | gate and any selected editable | `MarkModifiedRecursive` on each selected element (`.pas:12951`). Writes (sets modified flag so file is saved). |
| Add Masters... | gate, File, editable | `TfrmModuleSelect` "Which masters do you want to add?" then adds them (`.pas:8587`). Writes. |
| Sort Masters (to match current load order) | as Add Masters | `aFile.SortMasters` on selected files (`.pas:11322`). Writes. |
| Clean Masters (= Remove all unused Masters) | as Add Masters | `aFile.CleanMasters` (`.pas:3534`). Writes. |

**ModGroups (write to a sidecar `.modgroups` text file next to the data, not to a plugin)**

| Caption | Visible when | Effect |
| --- | --- | --- |
| Create ModGroup... | File focused and >1 file selected (`.pas:15600-15620`); also Ctrl+M | Dialogs `TfrmModuleSelect` / `TfrmModGroupEdit`; appends to `<module>.modgroups` (`.pas:4172-4300`). |
| Edit ModGroup... / Delete ModGroups... / Update CRC in ModGroups... | any ModGroup exists | `TfrmModGroupSelect` then edit / delete / refresh CRCs in the same files (`.pas:4441`, `4404`, `11975`). |

**Copy into another plugin (write)**

All go through `mniNavCopyIntoClick` (`.pas:3800`): gate, then `CopyInto` (`.pas:2960`) which shows `TfrmModuleSelect` "Which files do you want to add this record to?" (destination files only: editable, at or after the source's load order; excludes the source file unless overwriting), with EditorID prefix/suffix fields when multiple (`.pas:2986-3080`).

| Caption | Visible when |
| --- | --- |
| Copy as override into.... / (with overwriting) | gate, no File header selected (`not mniNavAddMasters.Visible`), record does not `ContainsReflection`; hidden when the whole selection are deep-copy-only kinds |
| Deep copy as override into.... / (with overwriting) | above and selection includes deep-copy record kinds (`SelectionIncludesAnyDeepCopyRecords`) |
| Copy as new record into... | override items visible and no selected kind is non-copy-new |
| Copy as wrapper into... / Copy as override (spawn rate plugin) into... | FO4/Skyrim leveled-list signatures only (LVLB, LVLC, LVLI, LVLN, LVLP, LVSC, LVSP), not FO76/Morrowind |
| Cleanup references to injected records | override visible and record `ReferencesInjected` (`.pas:4493`) |
| Copy Idle Animations into... | game ≤ FNV and no File selected (`.pas:3685`) |

**Other**

| Caption | Visible when | Effect |
| --- | --- | --- |
| Apply Script... | gate | `TfrmScript` picker (`xeScriptForm.dfm:5`), then runs a Pascal script over the selection (`.pas:9180`). Writes if the script does *(script-dependent)*. |
| Hidden (checkbox) | any element | `Element.Hide` / `Show` per selected node: display-only hiding of records (`.pas:12578`). `reads`. |
| Test / Bandit Fix | `DebugHook <> 0` / `Visible = False` in dfm | Developer items (`.pas:11331`, `9692`). |
| Other > Create Merged Patch | gate | Builds a merged patch plugin (`.pas:3848`). |
| Other > Create SEQ File | Skyrim and File | Writes `.seq` files (`.pas:4371`). |
| Other > Generate LOD | File, several games | `TfrmFileSelect` (worldspaces) + `TfrmLODGen` options; external LOD generation, output files (`.pas:10648`, `10770`, `10798`). |
| Other > Build Reference Info | always | `TfrmModuleSelect` picks modules; builds the Referenced By index (`.pas:10002`). Reads. |
| Other > Build Reachable Info | always | Builds reachability for all modules (`.pas:9969`). Reads. |
| Other > Fixup Race-specific LVLIs | `Visible = False` | Hidden (`.dfm:2675`). |
| Other > Localization > Localize / Delocalize plugin | Skyrim/FO4/FO76/SF and File with LoadOrder>0; caption follows `IsLocalized` (`.pas:15628-15640`) | `TfrmLocalizePlugin` then rewrites strings out of / into the plugin (`.pas:12754`, `12805`). Writes. |
| Other > Log Analyzer > ... | TES4/FO3/FNV/Skyrim | `TfrmLogAnalyzer` reads a log file (`.pas:12938`). Reads. |
| Other > Mark all files without ONAM as modified | always | (`.pas:16243`, item at `.dfm:2691`). Writes. |
| Other > Options | always | Options dialog (§5, §6). |
| Other > CodeSite logging | compiled out unless `USE_CODESITE` | Developer. |

### 1.4 `pmuNavHeaderPopup` (right-click on the nav column header)

`.dfm:3024`. Both items are `reads` (display order only).

| Caption | Visible when | Effect |
| --- | --- | --- |
| Files > as selected / always by load order / always by file name | always | Stores `Nav/FilesSort` in settings and re-sorts the file nodes (`mniNavHeaderFilesClick`, `.pas:12560`). |
| Dialog Topics > by Previous INFO / by FormID | `wbSortINFO` (`.pas:15398-15401`) | Sets how INFO records order under a DIAL (`.pas:2253`). |

Left-click on a header sorts by that column (§1.2).

### 1.5 `pmuNavAdd`

`.dfm:3135`, an empty popup. `pmuNavPopup` calls `pmuNavAdd.Items.Clear` (`.pas:15519`) but the Add entries are built under `mniNavAdd` instead (`.pas:15522-15545`); nothing populates `pmuNavAdd`. Its one caller is the Insert key with more than one Add entry, which pops it (`.pas:20414`). **Read as-is, that pops an empty menu**; the Add entries are reachable only through right-click → Add.

### 1.6 Search boxes on the left (same object, other gesture)

| Control | Behaviour |
| --- | --- |
| FormID (`edFormIDSearch`) | Enter: finds the record by load-order FormID (`0x` accepted), `JumpTo` it; green = found in tree, yellow = found but not in tree (filtered), red = not found (`.pas:5941-6058`). |
| EditorID (`edEditorIDSearch`) | Enter: next node whose EditorID *starts with* the text; skips hidden (`.pas:5808-5860`). Red / yellow / green as above. |
| Filename filter + RegEx | Filters the file nodes as typed (`edFileNameFilterChange`, `.pas:5863`). |

### 1.7 Gesture table — navigator

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Select record / file / group | reads | automatic (click) | record / plugin / group | Drives the right pane (`.pas:19698`); skipped when pinned |
| Select 2..N same-level records | reads | automatic (multi-select) | records | Auto-compares up to `wbAutoCompareSelectedLimit` (`.pas:20505`) |
| Expand / collapse | reads | double click, key (framework) | node | Alt+expand = full expand (`.pas:19932`) |
| Compare Selected | reads | menu | records (same signature) | Same effect as auto-compare, also reachable from Referenced By (§2) |
| Copy node text | reads | key (Ctrl+C) | selected nodes | Alt variant copies name / CRC |
| Focus filename filter | reads | key (`?`) | none | |
| Search by FormID / EditorID | reads | dialog answer (text + Enter) | record | Red/yellow/green feedback |
| Apply / Remove filter | reads | menu, dialog answer | file(s) | Conflict / cleaning presets skip the dialog |
| Hide / unhide | reads | menu | record | Display flag on the element (`.pas:12578`) |
| Check for errors, circular LVLI, LOOT report, Build Ref/Reachable | reads | menu | selection / all files | Output in Messages |
| Compare to... | reads | menu, dialog answer | plugin | Loads an extra file; not a plugin edit |
| Sort by column, Files sort mode | reads | click, menu | column / none | |
| Drag record to a View field | writes | drag | record (source), View element (target) | Nav is drag source only |
| Add group / record | writes | menu (submenu), key (Insert) | group / plugin (container) | Shift on group: N entries |
| Remove | writes | menu, key (Delete), dialog answer (confirm) | record(s), group(s) | Removes child groups too |
| Mark Modified | writes | menu | selection | |
| Change FormID | writes | menu, key (F2), dialog answer | record | Shift or multi-select renumbers into a target file |
| Change / Batch Change Referencing Records | writes | menu, dialog answer | record / plugin | |
| Renumber, Compact, Inject | writes | menu, dialog answer | plugin | |
| Add / Sort / Clean Masters | writes | menu, dialog answer | plugin | |
| Copy as override / new / wrapper / deep | writes | menu, dialog answer | record(s) → destination plugin | Destination chosen in Module Select |
| Create New File | writes | menu, dialog answer | none (template) | |
| Undelete & Disable, Remove Identical to Master, VWD toggle | writes | menu | selection | Cleaning group gated by `wbManualCleaningAllow` |
| Create delta patch, merged patch, SEQ, LOD | writes | menu, dialog answer | plugin / selection | New output files |
| Localize / Delocalize | writes | menu, dialog answer | plugin | |
| Create / Edit / Delete ModGroup, Update CRC | writes | menu (Ctrl+M for create), dialog answer | plugins | `.modgroups` sidecar file |
| Apply Script | writes | menu, dialog answer | selection | Script decides |

**Same object elsewhere.** A record is also shown in Referenced By (§2) and as a View column header (`pmuViewHeader`, §4). Copy-as-*, Remove, Mark Modified, Apply Script, Compare Selected are offered in all three; Change FormID, Add, Hide (nav) and Jump to (header) are not. See the matrix at the end.

---

## 2. Referenced By tab (`tbsReferencedBy`, `pmuRefBy`)

`.dfm:323-478`. A `TListView` (`lvReferencedBy`, `.dfm:328`): report style, owner-data (virtual), read-only, row-select, **multi-select**, columns Record, Signature, File, FormID, RawFileName (`.dfm:332-353`). The tab shows only when the selected record has referencers (`TabVisible := wbLoaderDone and Count>0`, `.pas:16800`, `17243`). Caption becomes `Referenced By (n)`, or `(n / F: filtered / S: selected)` when active (`.pas:8951`).

Filter row (`pnlReferencedByTop`, `.dfm:378`): Filter by Record, and/or, by Signature, AND by FileName; typed edits re-filter on a 250 ms timer (`tmrReferencedByFilterApply`).

| Input | Behaviour |
| --- | --- |
| Click column header | sorts; Ctrl+click = descending; a second click on Record sorts by FormID, on File by raw file name (`.pas:8025`) |
| Double click row | `JumpTo(record, False)` — selects the record in the nav tree and View; back history is pushed (`.pas:8140`) |
| Ctrl+A | select all (`.pas:8149`) |
| Ctrl+C | clipboard: FormID hex per selected row; Alt = record `Name` (`.pas:8168-8190`) |
| Delete | click `mniRefByRemove` if visible |
| Right click | `pmuRefBy` |
| Drag | none (no drag config in `.dfm:328-353`) |

### `pmuRefBy` items (`.dfm:3073`, popup `.pas:15671`)

`Selected` = selected rows as main records. Base condition `mniRefByCopyOverrideInto.Visible` = gate and ≥1 selected.

| Caption | Visible when | Effect |
| --- | --- | --- |
| Compare Selected (n) | gate, n>1, all same signature | Switches to View tab and compares them (`.pas:9372`). `reads`. |
| Apply Script... | gate, ≥1 selected | Same script dialog as nav, run on these records (`.pas:9180`). Script-dependent. |
| Copy as override into.... / with overwriting | base | `CopyInto` with the Module Select dialog (`.pas:9412`). `writes` (into another plugin). |
| Deep copy as override into.... / with overwriting | base and selection includes deep-copy kinds | Same. |
| Copy as new record into... | base and no non-copy-new kind | Same. |
| Copy as disabled override into.... | base | Copies and sets `IsInitiallyDisabled` (`.pas:9386-9410`). `writes`. |
| Remove | base | Confirmation `MessageDlg`; removes each record and its child group, drops it from history (`.pas:9462`). `writes`. |
| Mark Modified | base | `MarkModifiedRecursive` (`.pas:9437`). `writes`. |
| Visible When Distant / not Visible When Distant | every selected is an editable REFR; shows the opposite of what is set | Toggles VWD (`.pas:11573`). `writes`. |

Not offered here (offered in the nav): Change FormID, Add, Hidden, masters, filters. Not offered anywhere on this tab: any edit of the *reference* itself (the referencing field) — the row is the referencing **record**, not the field.

### Gesture table — Referenced By

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Sort by column | reads | click (Ctrl = descending) | column | |
| Filter by record / signature / file | reads | dialog answer (typed filter) | none | Filters this list only |
| Jump to referencing record | reads | double click | record | Navigates nav + View; pushes history |
| Select all | reads | key (Ctrl+A) | rows | |
| Copy FormID / name | reads | key (Ctrl+C) | rows | Alt = name |
| Compare Selected | reads | menu | records (same signature) | Also in nav |
| Copy as override / new / disabled / deep | writes | menu, dialog answer | record(s) → destination plugin | Same dialog as nav |
| Remove | writes | menu, key (Delete), dialog answer | record(s) | |
| Mark Modified | writes | menu | record(s) | |
| Toggle VWD | writes | menu | REFR record(s) | |
| Apply Script | writes | menu, dialog answer | record(s) | |

---

## 3. Messages tab (`tbsMessages`, `pmuMessages`)

`.dfm:479-500`. A single `TMemo` (`mmoMessages`, `.dfm:483`): scroll bars both, no word wrap, **no `ReadOnly` in the dfm and none set in `.pas` (grep `mmoMessages.ReadOnly` empty)**, so the log is editable text (*inferred*: TMemo default). Written to by `AddMessage` / `wbProgress`; also opened automatically for long operations (`pgMain.ActivePage := tbsMessages` at `.pas:2229`, `3681`, `10257`, `12284`). The shown tab set collapses to Messages alone when a load fails (`.pas:6570`).

| Gesture | Behaviour |
| --- | --- |
| Double click on a bracketed FormID `[XXXXXXXX]` or `[XXXX:XXXXXXXX]` **with Ctrl held** | Puts the FormID in the FormID search box and fires Enter → `JumpTo` (`.pas:9544-9575`). Without Ctrl, or under 8 chars, nothing. |
| Text selection, Ctrl+C, scroll | Standard TMemo *(inferred)* |

`pmuMessages` (`.dfm:3145`, no popup handler, so all items always visible):

| Caption | Effect |
| --- | --- |
| Clear | `mmoMessages.Clear` (`.pas:9577`). `reads` (clears display). |
| Save selected text | Trims selection; if non-empty, Save dialog (`*.txt`, starts in program dir), writes the text file (`.pas:9582-9600`). Writes a text file, not a plugin. |
| Autoscroll to the last message (check, default on) | Toggles `ScrollToTheLastMessage` (`.pas:1845`). |

### Gesture table — Messages

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Follow FormID in a message | reads | double click (Ctrl) | record | Uses same path as nav FormID search |
| Clear log | reads | menu | none | |
| Save selected text | reads | menu, dialog answer | none | Writes `.txt`; not a plugin |
| Toggle autoscroll | reads | menu (check) | none | |

A record referred to by FormID text in Messages is not offered any record gesture beyond jumping.

---

## 4. Information tab and `pmuViewHeader`

### 4.1 Information tab

`.dfm:501-878`, caption "Information". A read-only `TMemo` (`Memo1`, `ReadOnly = True`, `.dfm:~870`) of static help text: what the nav/View panes are, colour legend pointer, filtering, command-line switches, keyboard shortcut list including Ctrl+1..5 bookmarks and Ctrl+F3 (`.dfm:639-645`), and "Only Master and Leafs" explanation (`.dfm:830-860`). No popup menu, no handlers. There are no gestures beyond native scroll/select. Separate from the modal `TfrmTip` ("Tip" popups from `EditTips.txt`, off via Options "Show tip on start", `xeTipForm.pas:64`) and the "What's New?" rich-edit shown at start (`.pas:5328`).

### 4.2 `pmuViewHeader` (right-click on a **column header** of `vstView`)

`.dfm:2961`. The menu is attached only while the mouse is over a column that has an `ActiveRecords` entry (`vstViewHeaderMouseMove`, `.pas:19197-19206`). Each View column is one record, so this is a **record-level** menu for the record that column shows. Popup rules: `.pas:15753-15825`. Base gate: `wbEditAllowed`, not translation mode, column is a record column (`Column ≥ 1`) and its element is a main record; otherwise everything hidden.

| Caption | Visible when | Effect |
| --- | --- | --- |
| Copy as override into.... / (with overwriting) | base | `CopyInto` for that column's record → Module Select (`mniViewHeaderCopyIntoClick`, `.pas:10479-10520`). `writes`. |
| Deep copy as override into.... / (with overwriting) | base and record has a child group | Same. |
| Copy as new record into... | base and not CELL/WRLD/PGRD/NAVM/NAVI/LAND/ROAD | Same. |
| Copy as wrapper into... | LVLC/LVLI/LVSP/LVLN | Same. |
| Remove | base and the column's file is editable | Confirmation `MessageDlg`, removes the record from its file (`.pas:10566`). `writes`. |
| Jump to | base | `JumpTo(record, True)`: selects that column's record in the navigator (`.pas:10548`). `reads`. |
| Create ModGroup... | more than 2 records in View (`.pas:15757`) | Same handler as nav's (`mniNavCreateModGroupClick`). `writes` (sidecar). |
| Hide (check) | base | `Hide` / `Show` on that record, refreshes (`.pas:10525`). `reads` (display flag). |
| Unhide all... | base and master or any override hidden | Shows master and all overrides (`.pas:12333`). `reads`. |

Not offered here: Change FormID, Mark Modified, Add, Apply Script, Compare Selected.

### Gesture table — Info tab and View header

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Read Information | reads | automatic (tab select) | none | Static text |
| Copy record from column | writes | menu, dialog answer | record → destination plugin | Same `CopyInto` as nav |
| Remove record | writes | menu, dialog answer | record | |
| Jump to record in navigator | reads | menu | record | |
| Hide / Unhide record | reads | menu | record | |
| Create ModGroup | writes | menu | plugins | Sidecar `.modgroups` |

---

## 5. Main menu (`pmuMain`) and `pmuBtnMenu`

### 5.1 `pmuMain` — hamburger button

Button `bnMainMenu` (`.dfm:1371`): disabled until first load completes (`Enabled = False`, `.pas:21444` enables), opens `pmuMain` on left mouse down (`.pas:9083`). `pmuMainPopup` at `.pas:15354`. Only four groups; there is **no** New, Open, Quit, About or Settings menu bar.

| Item | Visible when | Kind | Effect |
| --- | --- | --- | --- |
| Localization > Language > (one radio item per available strings language) | Skyrim / FO4 / FO76 / SF (`.pas:15362`) | Application (loaded-string language) | Switches the active strings language (`mniMainLocalizationLanguageClick`, `.pas:12730`). Display. |
| Localization > Editor | same | Surface (opens dialog) | `TfrmLocalization.ShowModal` (`.pas:12718`); edits string tables, Save writes strings files. |
| Pluggy Link (GameLink) > Disabled / Reference / Base Object / Inventory / Enchantment / Spell | TES4, or `xEdit\xEditLink.ini` exists (`.pas:15385`); last three TES4 only | Application (external-game link mode) | Sets what xEdit sends to the running game (`mniMainPluggyLinkClick`, `.pas:2193`). |
| Save (Ctrl+S) | gate: `wbEditAllowed` and not `wbDontSave` (`.pas:15395`) | **Plugin action** | `SaveChanged`: `TfrmFileSelect` "Save changed files:" listing unsaved plugins (+ modified localization files), plus a "Backup plugins" check box; writes each checked file with a timestamped temp name, backs up originals (`.pas:16237`, `16291-16340`; `EditTips.txt:11-15`). |
| Options (Ctrl+O) | always | Application | `TfrmOptions` (`.pas:14599`): General, View, colours, fonts, etc. |

Save is the **only** main-menu item that writes plugin data. Nothing in `pmuMain` opens, loads, unloads or reorders plugins: the load order is fixed at start via the plugin-selection dialog (§6) and "You can't reorder plugins in xEdit" (`EditTips.txt:47`).

### 5.2 `pmuBtnMenu`

`.dfm:5393`; attached to the link-button strip `pnlBtn` (`.dfm:1590`). One item: **Shrink Buttons** (check, `.pas:15351`) toggles `wbShrinkButtons` (application, display). The strip itself is eight external-link buttons — PayPal, Patreon, NexusMods, Ko-Fi, Help, Videos, GitHub, Discord (`.dfm:1592-2089`) — each launching the browser (e.g. `bnHelpClick`, `.pas:9054`). Application-level.

### 5.3 Other main-window actions

| Control | Behaviour |
| --- | --- |
| Back / Forward (`acBack`, `acForward`) | walk navigation history: `JumpTo(history, backward)` (`.pas:1746`). Reads. |
| Path box `lblPath` | shows the focused node's path, coloured by conflict (`vstNavChange`, `.pas:19652-19690`). |
| Pin (`bnPinned`, View top) | stops the nav selection from changing the View (`IsPinned`). |
| Legend (`bnLegend`) | toggles the modeless Legend colour-key window (`.pas:9075`). |

### Gesture table — main menu

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Save changed plugins | writes | menu, key (Ctrl+S), dialog answer | plugin(s) (checked in list) | Backup check box; also prompted at exit if unsaved (`EditTips.txt:9-10`) |
| Open Options | reads | menu, key (Ctrl+O) | none | Options may change later behaviour |
| Switch strings language | reads | menu | none | |
| Open Localization Editor | reads | menu | none | Editor Save writes strings |
| Set Pluggy / Game Link mode | reads | menu | none | |
| Back / Forward | reads | click | record (history) | |
| Shrink Buttons | reads | menu | none | |
| Open Help / Patreon / GitHub / ... | reads | click | none | External browser |
| Pin / Unpin View | reads | click | none | |
| Toggle Legend | reads | click | none | |

---

## 6. Dialogs and secondary windows

Trigger column: where it is created (`.pas` line in `xeMainForm.pas` unless noted). Modal = `ShowModal`.

| Dialog (form) | Trigger | Asks | Changes |
| --- | --- | --- | --- |
| **Select Game Mode** (`xeGameSelectForm`, caption `.dfm:5`) | startup, only if no game inferred from exe name / switches (`xeInit.pas:667`) | Pick a game mode from a list | Sets process game mode |
| **Master/Plugin Selection** (`xeFileSelectForm`, `.dfm:5`) | startup load-order picker (`.pas:5370`, `5566`); also reused as a generic checklist: Save changed files (`16291`), filter-by-selected-files (`13980`), Copy Idle (`3738`), LODGen worldspaces (`10770`), spreadsheet keyword filter (`17518`, `17587`), ChangeReferencedBy (`17263`) | Which plugins to load / which items to act on. Search box, Backup check box (save use), right-click Select All / None / Invert (`.dfm:76-84`). Double click loads only that plugin and its masters; with option `RequireCtrlForDblClick` it needs Ctrl (`xeFileSelectForm.pas:83-85`; `EditTips.txt:50`). Shift+OK skips building references (`EditTips.txt:57`) | Startup: chooses what is loaded. Save use: chooses which files are written. |
| **Module Selection** (`xeModuleSelectForm`, `.dfm:5`) | Copy-into destination (`2986`), Add Masters (`8603`), Create New File template (`3289`), Change FormID target (`10192`), Renumber (`13060`), Build Reference Info (`10004`), ModGroup create / update (`4190`, `4267`, `11982`) | Pick modules; Preset combo with Load / Save / Delete, Filter box + RegEx, Select All / None / Invert; caption varies by caller ("Which masters do you want to add?", "What type of module do you want to create?") | Only returns the selection; the caller writes |
| **Filter...** (`xeFilterOptionsForm`, `.dfm:5`) | Nav "Apply Filter" (`13533`) | Preset; by conflict status (all/this), record signature, base-record signature/EditorID/FormID/name, EditorID / Name / element-value contains (+ RegEx), deleted, injected, not reachable, persistence, VWD, precombined, position/rotation changed, flatten blocks / cell children (`.dfm:32-417`) | Display only: prunes the nav tree; presets saved in settings |
| **Time to think...** (`xeEditWarningForm`, `.dfm:6`) | first write gesture in a session (`.pas:6060`) | "Yes I'm absolutely sure" / "let me think..." | Only unlocks the write |
| **View elements / extended editor** (`xeViewElementsForm`) | double click in View on a non-numeric cell (`.pas:18669`), or `mniViewEdit` (`10387`, see [xedit-ux-audit.md](xedit-ux-audit.md)) | One tab per compared plugin; Save, Close, Compare (external tool, "Configure external tool"), Copy. Modeless; modal with Shift or `wbIKnowWhatImDoing` | Save writes the element value back |
| **Apply Script** (`xeScriptForm`, `.dfm:5`) | nav or Referenced By "Apply Script..." (`.pas:9185`) | Which script; Filter box; "Include scripts from subdirectories" | Runs it over the selection |
| **LODGen Options** (`xeLODGenForm`, `.dfm:5`) | Nav > Other > Generate LOD (`10798`) | Worldspaces; objects / trees LOD; atlas and texture settings; brightness | Runs the LOD generator, writes LOD output files |
| **Localization Editor** (`xeLocalizationForm`, `.dfm:4`) | pmuMain > Localization > Editor (`12723`); also View edit of a localized string (`10413`) | Edit string tables; Save; Export to / Import from file | Writes strings files |
| **Localize plugin** (`xeLocalizePluginForm`, `.dfm:5`) | Nav > Other > Localization > Localize (`12805`) | From-language, To-language, translation option | Converts a plugin to/from localized strings |
| **ModGroup Selection / Edit** (`xeModGroupSelectForm`, `xeModGroupEditForm`) | Nav ModGroup items (`4257`, `4410`, `4449`, `4466`, `12031`) | Pick or name a group | `.modgroups` sidecar |
| **Options** (`xeOptionsForm`, `.dfm:5`) | pmuMain / Ctrl+O / Nav > Other (`14605`) | Tabs General, View, colours/fonts: e.g. Hide unused, Load BSAs, Show file header flags, Reset Modified (Bold) on Save, Always save ONAM, Hide Manual Cleaning functions, fields/types collapsed by default (`.dfm:33-348`) | Settings ini only; some need restart |
| **Worldspace Cell** (`xeWorldspaceCellDetailsForm`, `.dfm:5`) | callback at `xeWorldspaceCellDetailsForm.pas:61` | X, Y, Persistent / Temporary | Returns X/Y grid cell and persistent/temporary flag through `wbGetCellDetailsForWorldspaceCallback` (`xeWorldspaceCellDetailsForm.pas:57-73`); the Core caller that triggers it was not traced |
| **Log Analyzer** (`xeLogAnalyzerForm`) | Nav > Other > Log Analyzer (`12940`) | Log file, size, first N | Reads only |
| **What's New / Tip / Developer message** (`xeRichEditForm`, `xeTipForm`, `xeDeveloperMessageForm`) | startup (`5328`, `21168`, `17353`) | Read-only notices with "don't show again" | Settings ini |
| **Legend** (`xeLegendForm`) | Legend button (`.pas:9075`) | none | Modeless colour key; selects the cell for the focused conflict state (`.pas:18940-18955`) |
| **Wait / progress** (`xeWaitForm`) | long actions (`PerformLongAction`) | Cancel | none |
| **Element detail** (`xeElementDetailForm`) | none | Empty placeholder `TForm1` with no controls (`.dfm:1-4`, `.pas:19-27`) | Dead |

### Gesture table — dialogs

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Choose plugins to load | reads | dialog answer | plugins | Startup; Shift+OK skips reference build |
| Load only this plugin (+masters) | reads | double click | plugin | Ctrl needed under `RequireCtrlForDblClick` |
| Select all / none / invert | reads | menu (right-click) | list rows | Module, plugin, ModGroup selectors |
| Choose destination plugin(s) | writes | dialog answer | plugin | The copy happens after OK; per-record prefix/suffix for multiple |
| Choose masters to add | writes | dialog answer | plugin | |
| Set filter options | reads | dialog answer | none | |
| Confirm edit warning | reads | dialog answer | none | Unlocks writes |
| Confirm removal | writes | dialog answer | record(s) | Yes/No `MessageDlg` |
| Choose plugins to save | writes | dialog answer | plugin(s) | Backup toggle |
| Pick script | writes | dialog answer | script | |
| Save element from extended editor | writes | dialog answer (Save) | element across compared records | |
| Save / export / import strings | writes | dialog answer | strings file | |
| Change Options | reads | dialog answer | none | Persists to settings |

---

## 7. Spreadsheet tabs (WEAP / ARMO / AMMO)

Three tabs — Weapon, Armor, Ammo Spreadsheet (`.dfm:879`, `1083`, `1223`): each a `TVirtualEditTree` (`vstSpreadSheetWeapon`, `vstSpreadsheetArmor`, `vstSpreadSheetAmmo`) with multi-select (`.dfm:905`, `1109`, `1249`), sharing `pmuSpreadsheet` (`.dfm:2945`). They are tabular summaries of every record of that signature across all loaded plugins, built when a tab is shown (`tbsSpreadsheetShow`, `.pas:17434`; keyword picker via `TfrmFileSelect`, `17518`). Tabs are made visible only for Oblivion and Skyrim (`.pas:21217-21219`), hidden by default (`.pas:5142-5144`).

| Gesture | Effect | Trigger | Argument | Notes |
| --- | --- | --- | --- | --- |
| Select several rows | reads | click (multi-select) | records | |
| Compare Selected | reads | menu | records | Visible only with >1 selected (`.pas:15746`); `JumpTo` compare history entry (`.pas:12305`) |
| Rebuild | reads | menu | tab | Clears and rebuilds the table (`.pas:12324`) |
| Open a tab (build table, filter keywords) | reads | click (tab), dialog answer | signature | Ctrl-hover link affordance like the View (`vstSpreadSheetCheckHotTrack`, `.pas:20613`) |

---

## Object x surface

Rows are xEdit objects; cells list the gestures offered on that surface. "—" = none. Gestures named as in the tables above.

| Object | Navigator (`pmuNav`) | Referenced By | Messages | View header (`pmuViewHeader`) | Main menu / dialogs | View grid ([audit](xedit-ux-audit.md)) |
| --- | --- | --- | --- | --- | --- | --- |
| **Plugin / file** | Compare to, delta patch, Add / Sort / Clean Masters, Renumber / Compact / Inject, Create ModGroup, Localize, Generate LOD, SEQ, merged patch, Mark Modified, Remove filter / Apply filter (selected files), Copy Ctrl+C, Hide | — (rows only show the file name as a column) | — | Remove (record only, gated by file editable), Create ModGroup | **Save** (Ctrl+S) is the only plugin write; plugin selection at startup; Create New File | Column-level file identity is the header label only |
| **Record** | Select / auto-compare, Compare Selected, Add (into group), Remove, Mark Modified, Change FormID (F2), Change Referencing Records, Copy as override / new / wrapper / deep, Cleanup injected, VWD toggle, Hide, Apply Script, Check for errors, drag to a View field, Ctrl+C | Jump to (double click), Compare Selected, Copy as override / new / disabled / deep, Remove, Mark Modified, VWD toggle, Apply Script, Ctrl+C | Jump to (Ctrl+double click on `[FormID]` text) | Copy as override / new / wrapper / deep, Remove, Jump to, Hide / Unhide, Create ModGroup | Copy-into dialog picks destination; Remove confirmation | Column = one record; Ctrl+click on a reference field follows to a record |
| **Element / field** | Add (child of container), Remove (chapter/branch nodes), Mark Modified (`EditableSelection` includes non-record elements) | — | — | — | Extended editor dialog (Save) | All field gestures: inline edit, Ctrl+C/X/V, Add / Remove / Clear, Move Up / Down, Copy to selected, Stick to, drag (see audit) |
| **Reference (link)** | Referrers reachable indirectly: Change Referencing Records, Batch Change; Build Reference Info | Each row *is* a referencing record; no gesture edits the reference field itself | FormID text is followable (Ctrl+double click) | — | — | Ctrl+click follows the link; drop a nav record onto the field assigns the link |

**Where the same object recurs.** A record appears in the navigator, as a Referenced By row, in a Messages FormID, and as a View column. Gestures common to navigator, Referenced By and View header: Copy as override / new / deep (same `CopyInto` dialog), Remove (same confirmation). Only in the navigator: Change FormID, Add, Hide (nav) / Unhide all (header), Apply Script beside Referenced By, Change Referencing Records, masters, filters. Only in Referenced By: Copy as disabled override, sort / filter. Only in the View header: Jump to, Create ModGroup by column. Messages offers navigation only. The spreadsheets offer only Compare Selected and Rebuild.

## Surprising or worth noting (all read)

- `pmuNavAdd` is never populated; the Insert key with several Add entries pops an empty menu (`.pas:15519`, `20414`).
- The nav tree has no double-click, click, or drop handler of its own; double click is framework expand/collapse, and it is a drag *source* only, the View grid is the target (`.pas:21574-21590`, `7138`).
- Selecting 2+ records auto-compares with no menu action, up to `wbAutoCompareSelectedLimit` (`.pas:20505`).
- Ctrl+1..5 bookmarks, F5, Ctrl+F3, Alt+F3 and Ctrl+W are described in `EditTips.txt` and the Information tab but have no handler in `xeMainForm.pas`.
- The main menu is four groups; Save (Ctrl+S) is its only plugin write, with a per-plugin checklist and backup toggle.
- Menus never grey items: visibility is the whole rule, and key accelerators re-evaluate the same visibility (`.pas:20397-20420`).
- The Messages memo is not marked read-only; the log is editable text.
- `xeElementDetailForm` is an empty stub form.
