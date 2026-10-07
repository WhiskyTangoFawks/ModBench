# xEdit: divergences and omissions

Where xEdit has an answer, Modbench adopts it ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md)). This file lists every place it does not.

What xEdit does: [the surface audit](../research/xedit-surface-audit.md) and [the grid audit](../research/xedit-ux-audit.md).

## Omissions by reason

| Reason | Why | Gestures | Examples |
|---|---|---|---|
| VS Code provides it | VS Code already supplies settings, editor history and pinning, the Output and Problems panels, and themes ([principles](../principles.md), Existing tools). | 15 | Change options; Switch the strings language; Sort files: as selected, by load order, by name |
| Standalone application | xEdit loads a fixed plugin set and saves on demand. Modbench indexes every plugin in the instance and writes edits to a working tree ([ADR-0007](../adr/0007-plugin-edits-are-git-working-tree-changes.md)). | 4 | Select game mode; Choose plugins to load; Choose plugins to save, with a backup toggle |
| An ADR decides it | A decision covers the gesture. Masters are derived ([ADR-0008](../adr/0008-masters-are-derived-from-content.md)). Edits are git changes ([ADR-0007](../adr/0007-plugin-edits-are-git-working-tree-changes.md)). The index is always current ([ADR-0003](../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file-used-by-another-program.md), [ADR-0012](../adr/0012-index-every-plugin-filter-to-the-active-ones.md)). | 7 | Compare to another plugin file; Add masters; Sort masters |
| Platform | The gesture relies on something Modbench lacks, such as dragging from a tree into a webview. | 1 | Drag a record onto a reference field |
| Game-specific | It serves one or two games, or one engine. Modbench generalizes across Bethesda games. | 6 | Set the game-link mode (Pluggy); Create SEQ file (Skyrim); Set VWD on all REFRs with a VWD mesh (Oblivion) |
| Scripts, tasks or the agent | The operation is multi-step. A Python script, a task or the agent delivers it. It is not a gesture. | 19 | Compact FormIDs for ESL; BOSS / LOOT cleaning report; Batch change referencing records |
| Maintainer ruling | The maintainer decided the gesture is unnecessary. The gesture name says why. | 15 | Hide a plugin in the navigator (filters hide a class of things); Hide or unhide one record; unhide all overrides (filters hide a class of things); Stick to (a view preference) |
| Dead in xEdit | xEdit documents or ships it, and no working handler exists. | 3 | Temporary and Persistent nav items; Element detail form; Bookmarks (Ctrl+1 to 5, Alt+1 to 5), F5, Ctrl+F3, Alt+F3, Ctrl+W |

## Divergences

Gestures Modbench does differently.

| # | Where | Modbench | xEdit | Why |
|---|---|---|---|---|
| 1 | FormKey editing | A native QuickPick | A sorted combo box | Limitation: VS Code hosts a searchable thousand-row picker better than a webview can. |
| 2 | The extended editor | A VS Code editor tab | A modeless form | Limitation. |
| 3 | Copy as New Record | Prompts for nothing. The copy lands under a derived EditorID, as the Creation Kit does, and is renamed in the grid. It never mints a duplicate EditorID. | Prompts for an EditorID | Ruling. |
| 4 | Row painting | NoConflict, OnlyOne and expanded struct rows are unpainted, so a background colour means "something here needs attention" | Tints every row | Ruling. |
| 5 | Flags row | Expands into an in-cell checkbox list, collapsed to xEdit's compact name summary | Opens a transient check-combo | Ruling. |
| 6 | Left click and the extended editor | A string cell's second click, F2 and double click open the inline editor, like every other scalar. The extended editor opens from the right-click menu. | Double click opens the extended editor, which is modeless | VS Code's interaction: VS Code edits a value in place, as its inline rename does. |
| 7 | ConflictPriority table | None, but for the version stamps: Version Control Info 1, Form Version and Version Control Info 2 show, and take part in no conflict. Mutagen abstracts away the other raw-binary fields the priorities paper over. | A priority table | Ruling. Closed, not deferred. |
| 8 | Following a reference | A Go to Record item in the right-click menu | Ctrl + click | Limitation: a webview has no supported way to bind a modifier click. The menu item is the VS Code way. |
| 9 | Change FormID | Editing the FormID field changes the record's FormKey only. A script updates the records that reference it. | Change FormID also updates every loaded record that references it | Ruling: updating the references is a compound action, so it is a script. |
| 10 | Reference text | `EditorID [FormKey]` | `EditorID "Full Name" [SIG:FormID]` | Ruling: the FormKey is the record's identity, and a FormID changes with the load order. |
| 11 | No reference | `—` | `NULL - Null Reference [00000000]` | Ruling. |
| 12 | Byte arrays | `0x` and the bytes in uppercase hex, Mutagen's spelling | Its own format, which the clone does not carry | Ruling. |
| 13 | Unused condition parameters | No row while no column uses them, and a change of function empties them | The string parameters are always rows | Ruling: a parameter the function does not use does nothing, so its row would only mislead. |
| 14 | Sorted arrays | Kept in the order they have; an array without a key aligns by its values in sequence, and every array takes add and remove, and an array without a key takes move | Sorts `wbArrayS` arrays on save and aligns them by value, with no move | Ruling: the game does not need the order, so sorting is xEdit's habit reaching into the data, and Mutagen decides the data. |
| 15 | Referenced By | One row per referrer, with a row for each active plugin that holds the reference beneath it | One row per plugin's copy of each referring record | Ruling. |
| 16 | The FormID row | Shows and takes the FormKey, under xEdit's label | Shows the FormID in load order | Mutagen decides the data: a FormID changes with the load order (divergence 10). |
| 17 | Collapsed readings | The four readings in editor-fields.md, an array element's key, and an array's one element; any other array reads `[n]` | A summary per definition: summary keys and hand-written callbacks, for each game, and `<N entries>` | Ruling: the generic rules come from what mEdit's schema already knows, and a per-definition port is upkeep for every game. |
| 18 | Record Header | The header members Mutagen reads, with no Signature or Data Size row | Signature and Data Size rows | Mutagen decides the data: the data size is derived on each write, and the header line names the record type. |
| 19 | Colours and vectors | One text box: `#AARRGGBB`, or `x, y, z` | A struct of their parts: Red, Green, Blue, and Alpha or Unused; X, Y and Z | Ruling, Minimal by default: one row per value, not three or four. A conflict colours the whole value, not one part. |
| 20 | Alias numbers | The number | The alias's name, from the field's quest | Ruling: Mutagen types an alias as an integer, and each field finds its quest in its own way, so a reading is a port per definition and per game (divergence 17). |
| 21 | Field order | The order the record holds them in its file, as Mutagen groups them into fields | The order of its definition | Mutagen decides the data: where Mutagen groups subrecords into fields differently, its grouping decides the order. |
| 22 | Navigator conflict state | None on the Plugins tree. The record filter finds conflicts, and the record panel shows them. | Colours each record node by ConflictAll and ConflictThis | Limitation: a VS Code tree row has no background, and its label colour holds git's badge. |
| 23 | A deleted reference | Keeps only its record header | Keeps its base record from FO4 on | Mutagen decides the data: Mutagen writes a deleted record as its header alone. |
| 24 | Persistent on a deleted record | Refused, naming the reason | Reverts the change in silence | Principle: Never silently wrong. |
| 25 | Two flag changes in one write | Clearing Partial Form and setting Deleted on a Partial Form copy leaves it Deleted | Reverts it to Partial Form, by the order it applies the two changes | Ruling: a write ends as it asks. |
| 26 | Deep copy as override into a plugin that holds some of the child records | One confirmation for the selection | Two items: one keeps each record the destination holds; one, with overwriting, asks for each | Principle, Minimal by default: one gesture asks once. |
| 27 | Create a cell at a grid position the worldspace already has | Refused, naming the cell. The refusal for a master's cell points at copy as override. | Returns the plugin's cell, or makes an override of the master's | Ruling: create never turns into an override (commands.md, Principles). |
| 28 | A plugin whose master is not active | Stays active and indexed, its row flagged with a master issue; its dependants are untouched | Deactivates it and every plugin that depends on it | Mutagen decides the data: xEdit cannot load a plugin without its master; Mutagen can. The picture then shows the load order the user has, as MO2's does. |
| 29 | The order of a container's child records | Kept as the plugin holds it | Sorts a changed group by FormID when it saves it. For Oblivion to Skyrim it orders a topic's responses by their previous-response chain. | Ruling: [ADR-0020](../adr/0020-a-child-record-lives-in-its-containers-document.md). |

## Omissions by object

Gestures Modbench does not offer. A gesture ruled out is not in [commands.md](../architecture/commands.md). Look up the object; the Reason column names the row in the table above.

### Instance

| Gesture | xEdit | Reason |
|---|---|---|
| Change options | Main menu: Options (Ctrl+O) | VS Code provides it |
| Switch the strings language | Main menu: Localization > Language | VS Code provides it |
| Select game mode | Startup dialog: Select Game Mode | Standalone application |
| Choose plugins to load | Startup dialog: Master/Plugin Selection | Standalone application |
| Set the game-link mode (Pluggy) | Main menu: Pluggy Link | Game-specific |

### Plugin

| Gesture | xEdit | Reason |
|---|---|---|
| Choose plugins to save, with a backup toggle | Main menu: Save (Ctrl+S) | Standalone application |
| Sort files: as selected, by load order, by name | Navigator header menu | VS Code provides it |
| Compare to another plugin file | Navigator: Compare to... | An ADR decides it |
| Add masters | Navigator: Add Masters... | An ADR decides it |
| Sort masters | Navigator: Sort Masters | An ADR decides it |
| Clean masters | Navigator: Clean Masters | An ADR decides it |
| Mark all files without ONAM as modified | Navigator: Other | An ADR decides it |
| Build reference info | Navigator: Other | An ADR decides it |
| Build reachable info (not needed; ADR-0010 revisits it if reachability becomes a feature) | Navigator: Other | Maintainer ruling |
| Filter presets: apply, remove, conflicts, cleaning (a preset is a saved `.sql` file, which the record filter picks) | Navigator: Apply Filter... | Maintainer ruling |
| Filter presets on selected files only (a preset is a saved `.sql` file, which the record filter picks) | Navigator | Maintainer ruling |
| Create SEQ file (Skyrim) | Navigator: Other > Create SEQ File | Game-specific |
| Set VWD on all REFRs with a VWD mesh (Oblivion) | Navigator: Cleaning | Game-specific |
| Compact FormIDs for ESL | Navigator | Scripts, tasks or the agent |
| Hide a plugin in the navigator (filters hide a class of things) | Navigator: Hidden | Maintainer ruling |
| BOSS / LOOT cleaning report | Navigator | Scripts, tasks or the agent |
| Create a ModGroup (ModGroups are dropped as a feature) | Navigator: Create ModGroup..., Ctrl+M | Maintainer ruling |
| Edit or delete a ModGroup, update CRCs (ModGroups are dropped as a feature) | Navigator | Maintainer ruling |
| Batch change referencing records | Navigator | Scripts, tasks or the agent |
| Create delta patch | Navigator: Create delta patch using... | Scripts, tasks or the agent |
| Create merged patch | Navigator: Other > Create Merged Patch | Scripts, tasks or the agent |
| Generate LOD | Navigator: Other > Generate LOD | Scripts, tasks or the agent |
| Undelete and disable references | Navigator: Cleaning | Scripts, tasks or the agent |
| Remove records identical to master | Navigator: Cleaning | Scripts, tasks or the agent |
| Localize or delocalize a plugin | Navigator: Other > Localization | Scripts, tasks or the agent |
| Edit strings tables | Main menu: Localization > Editor | Scripts, tasks or the agent |

### Record

| Gesture | xEdit | Reason |
|---|---|---|
| Repoint references | Navigator: Change Referencing Records | Scripts, tasks or the agent |
| Copy a field value to the other selected records | View grid: Copy to selected | Scripts, tasks or the agent |
| Toggle visible-when-distant on several records | Navigator, Referenced By | Scripts, tasks or the agent |
| Hide or unhide one record; unhide all overrides (filters hide a class of things) | Navigator: Hidden; View header: Hide, Unhide all | Maintainer ruling |
| Copy as wrapper (leveled lists) | Navigator, View header | Scripts, tasks or the agent |
| Copy as disabled override | Referenced By | Scripts, tasks or the agent |
| Copy as override for spawn rate (leveled lists) | Navigator | Game-specific |
| Clean up references to injected records | Navigator | Scripts, tasks or the agent |
| Drag a record onto a reference field | Navigator drag, View drop | Platform |
| Stick to (a view preference) | View grid | Maintainer ruling |
| Create a ModGroup from columns (ModGroups are dropped as a feature) | View grid: Ctrl+M | Maintainer ruling |
| Select all rows in Referenced By | Referenced By | VS Code provides it |
| Back and forward history | Back, Forward | VS Code provides it |
| Follow a FormID in a message | Messages: Ctrl + double click | VS Code provides it |
| Mark modified | Navigator, Referenced By: Mark Modified | An ADR decides it |
| Copy idle animations (games up to FNV) | Navigator | Game-specific |
| Spreadsheet tabs: WEAP, ARMO, AMMO | Spreadsheet tabs (Oblivion, Skyrim only) | Game-specific |
| Apply a script over the selection | Navigator, Referenced By: Apply Script... | Scripts, tasks or the agent |
| Choose the next or previous member of a union (the Kind dropdown chooses it) | View grid: Next Member, Previous Member | Maintainer ruling |
| Reset a structure to its defaults | View grid: Reset structure | Scripts, tasks or the agent |
| Copy a field's path or full path (nothing in Modbench takes a path) | View grid: Clipboard > Copy path, Copy full path | Maintainer ruling |
| Choose a column-width mode (a column fits, and its edge drags) | View grid: Column widths | Maintainer ruling |
| Jump to the record in the navigator (Plugins shows it, and Go Back returns) | View header: Jump to | Maintainer ruling |
| Create on a cell's persistent or temporary group (create on the cell; Persistent moves it) | Navigator: Add | Maintainer ruling |
| Create a worldspace's persistent cell (setting Persistent on a reference creates it) | Navigator: Add, CELL [P] | Maintainer ruling |

### No object

| Gesture | xEdit | Reason |
|---|---|---|
| Toggle the color legend | Legend button | VS Code provides it |
| Pin or unpin the View | Pin button | VS Code provides it |
| Shrink the link buttons | Main menu: Shrink Buttons | VS Code provides it |
| Open help, forum and donation links | Link strip | VS Code provides it |
| Read the Information tab | Information tab | VS Code provides it |
| Read tips and What's New | Tip and What's New dialogs | VS Code provides it |
| Clear the messages log | Messages menu (Problems panel in Modbench) | VS Code provides it |
| Save selected messages as text | Messages menu | VS Code provides it |
| Toggle messages autoscroll | Messages menu | VS Code provides it |
| Confirm the one-time edit warning | Dialog: Time to think... | Standalone application |
| Log analyzer | Navigator: Other | Scripts, tasks or the agent |
| Temporary and Persistent nav items | Never visible | Dead in xEdit |
| Element detail form | Empty stub form | Dead in xEdit |
| Bookmarks (Ctrl+1 to 5, Alt+1 to 5), F5, Ctrl+F3, Alt+F3, Ctrl+W | Documented in tips, no handler | Dead in xEdit |
