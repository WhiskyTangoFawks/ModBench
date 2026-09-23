# xEdit: divergences and omissions

Where xEdit has an answer, Modbench adopts it ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md)). This file lists every place it does not. A divergence needs a platform limit or a maintainer ruling. An omission needs a reason from the table below.

What xEdit does: [the surface audit](../research/xedit-surface-audit.md) and [the grid audit](../research/xedit-ux-audit.md).

## Omissions by reason

| Reason | Why | Gestures | Examples |
|---|---|---|---|
| VS Code provides it | VS Code already supplies settings, editor history and pinning, the Output and Problems panels, and themes ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)). | 15 | Change options; Switch the strings language; Sort files: as selected, by load order, by name |
| Standalone application | xEdit loads a fixed plugin set and saves on demand. Modbench indexes every plugin copy and writes edits to a working tree ([ADR-0007](../adr/0007-plugin-edits-are-git-working-tree-changes.md)). | 4 | Select game mode; Choose plugins to load; Choose plugins to save, with a backup toggle |
| An ADR decides it | A decision covers the gesture. Masters are derived ([ADR-0008](../adr/0008-masters-are-derived-from-content.md)). Edits are git changes ([ADR-0007](../adr/0007-plugin-edits-are-git-working-tree-changes.md)). The index is always current ([ADR-0009](../adr/0009-the-record-index-mirrors-the-files-on-disk.md), [ADR-0012](../adr/0012-every-plugin-copy-is-indexed.md)). Filtering is user-written SQL. | 10 | Compare to another plugin file; Add masters; Sort masters |
| Platform | The gesture relies on something Modbench lacks, such as dragging from a tree into a webview. | 1 | Drag a record onto a reference field |
| Game-specific | It serves one or two games, or one engine. Modbench generalizes across Bethesda games. | 6 | Set the game-link mode (Pluggy); Create SEQ file (Skyrim); Set VWD on all REFRs with a VWD mesh (Oblivion) |
| Scripts, tasks or the agent | The operation is multi-step. A Python script, a task or the agent delivers it. It is not a gesture. | 18 | Compact FormIDs for ESL; BOSS / LOOT cleaning report; Batch change referencing records |
| Metadata chrome | The feature annotates or organizes a list inside xEdit's UI. Separators already organize Modbench's lists, and nothing in Modbench consumes it. | 3 | Create a ModGroup; Edit or delete a ModGroup, update CRCs; Create a ModGroup from columns |
| Maintainer ruling | The maintainer decided the gesture is unnecessary. The gesture name says why. | 3 | Hide a plugin in the navigator (filters hide a class of things); Hide or unhide one record; unhide all overrides (filters hide a class of things); Stick to (a view preference) |
| Dead in xEdit | xEdit documents or ships it, and no working handler exists. | 3 | Temporary and Persistent nav items; Element detail form; Bookmarks (Ctrl+1 to 5, Alt+1 to 5), F5, Ctrl+F3, Alt+F3, Ctrl+W |

## Divergences

Gestures Modbench does differently.

| # | Where | Modbench | xEdit | Why |
|---|---|---|---|---|
| 1 | FormKey editing | A native QuickPick | A sorted combo box | Limitation: VS Code hosts a searchable thousand-row picker better than a webview can. |
| 2 | The extended editor | A VS Code editor tab | A modeless form | Limitation. |
| 3 | The clipboard | The extension host writes it, not the webview | - | Limitation, with no visible difference. |
| 4 | Tracking, compile and branches | Follow git and VS Code ([ADR-0007](../adr/0007-plugin-edits-are-git-working-tree-changes.md)) | No model for review, revert or history | Product difference. |
| 5 | Copy as New Record | Prompts for nothing. The copy lands under a derived EditorID, as the Creation Kit does, and is renamed in the grid. It never mints a duplicate EditorID. | Prompts for an EditorID | Ruling. |
| 6 | Row painting | NoConflict, OnlyOne and expanded struct rows are unpainted, so a background colour means "something here needs attention" | Tints every row | Ruling. |
| 7 | Flags row | Expands into an in-cell checkbox list, collapsed to xEdit's compact name summary | Opens a transient check-combo | Ruling. |
| 8 | Left click and the extended editor | No left click leaves the record panel. The extended editor opens only from the right-click menu. A string cell's second click, F2 and double click open the inline editor, like every other scalar. | Double click opens the extended editor, which is modeless | Ruling: a tab relocates the user where xEdit's modeless editor did not. |
| 9 | ConflictPriority table | None. Mutagen abstracts away the raw-binary fields the priorities paper over. | A priority table | Ruling. Closed, not deferred. |
| 10 | Following a reference | A Go to Record item in the right-click menu | Ctrl + click | Limitation: a webview has no supported way to bind a modifier click. The menu item is the VS Code way. |
| 11 | Change FormID | Renumber changes the record's FormKey only. A script updates the records that reference it. | Change FormID also updates every loaded record that references it | Ruling: updating the references is a compound action, so it is a script. |

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
| Build reachable info | Navigator: Other | An ADR decides it |
| Filter presets: apply, remove, conflicts, cleaning | Navigator: Apply Filter... | An ADR decides it |
| Filter presets on selected files only | Navigator | An ADR decides it |
| Create SEQ file (Skyrim) | Navigator: Other > Create SEQ File | Game-specific |
| Set VWD on all REFRs with a VWD mesh (Oblivion) | Navigator: Cleaning | Game-specific |
| Compact FormIDs for ESL | Navigator | Scripts, tasks or the agent |
| Hide a plugin in the navigator (filters hide a class of things) | Navigator: Hidden | Maintainer ruling |
| BOSS / LOOT cleaning report | Navigator | Scripts, tasks or the agent |
| Create a ModGroup | Navigator: Create ModGroup..., Ctrl+M | Metadata chrome |
| Edit or delete a ModGroup, update CRCs | Navigator | Metadata chrome |
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
| Create a ModGroup from columns | View grid: Ctrl+M | Metadata chrome |
| Select all rows and sort in Referenced By | Referenced By | VS Code provides it |
| Jump to a record; back and forward history | Jump to, Back, Forward | VS Code provides it |
| Follow a FormID in a message | Messages: Ctrl + double click | VS Code provides it |
| Mark modified | Navigator, Referenced By: Mark Modified | An ADR decides it |
| Copy idle animations (games up to FNV) | Navigator | Game-specific |
| Spreadsheet tabs: WEAP, ARMO, AMMO | Spreadsheet tabs (Oblivion, Skyrim only) | Game-specific |
| Apply a script over the selection | Navigator, Referenced By: Apply Script... | Scripts, tasks or the agent |

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
