# Commands

This file owns the UX vocabulary and the catalog of gestures. `CONTEXT.md` owns the domain vocabulary. A gesture or command the code has and this file lacks is a defect in the code. A gesture this file has and the model cannot hold is a ticket.

- Object: a domain noun the user acts on: Instance, Profile, Mod, Separator, Plugin, Record, Referrer, Downloaded file. `CONTEXT.md` defines each one. Settings is Modbench's own configuration, which VS Code stores at user and workspace scope. It is the object of `open settings` only, and `CONTEXT.md` does not define it, because it is not a domain noun.
- Surface: what a driving box presents to the user. One surface per driving box on the Modbench side. A surface shows objects and offers their gestures. A VS Code view or an editor realizes it.
- Gesture: one thing the user does to an object. One row in the tables below, under the object it changes. The Gesture column holds the verb the user sees, in a menu or a label.
- Exclude and hide: to exclude is to mark an object durably on disk. The mark leaves the object out of something until include clears it, as the Downloads list leaves out an excluded downloaded file. To hide acts on the view alone. It changes nothing on disk and ends with the window, like hide excluded or a name filter.
- System command: a command Modbench runs itself. No user starts it and no surface owns it, so it has no gesture. Its first column is the trigger that fires it. It has its own section, after the objects.
- Where: each surface's Menus and keys lists the gestures it offers, where each sits and on what condition.
- Effect: `writes` when the gesture ends in a Core command that writes a file, a repository or a folder. `reads` when it only changes what the surface shows, or opens something. `runs` when it starts another program and writes nothing itself. `edits` when the gesture changes plugin source as a VS Code workspace edit and writes nothing itself. Saving the documents writes their files ([ADR-0001](../adr/0001-modbench-is-a-vscode-extension.md)).
- Command ID: the registered interface and the source of truth, which the code reflects. It is `modbench.<object>.<verb>`, in camelCase, and the object owns it (`modbench.mod.enable`, `modbench.downloadedFile.delete`). `-` means the gesture has none. A gesture every list view does to whatever it shows is `modbench.<verb>`, in Every view.
- Options: the inputs a gesture needs besides its Argument, such as a mode, a destination or a position. A picker asks for each Option the caller did not supply. An Option may be computed and multi-valued, such as a checked list with defaults.
- Argument: the value that identifies the object or objects to the gesture, such as a plugin as `(origin, filename)`, or a FormKey. For a gesture that creates an object, it identifies the container, when the entry point is on the container's row. A create from a title icon has none, and its container is an Option. It is the same on every surface that offers the gesture. Singular means the clicked row, and plural means the whole selection.
- Template: the source, xEdit ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md)) or MO2 ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)) gesture this row follows, read from [the xEdit audit](../research/xedit-surface-audit.md), [the xEdit grid audit](../research/xedit-ux-audit.md) and [the MO2 audit](../research/mo2-surface-audit.md). `none` means the template has no such gesture: the row is an addition or a divergence, and needs a ruling.
- Trace: the sequence diagram of the gesture's flow. `-` means the trace is still to draw, and drawing it is part of designing the gesture. `none` means the gesture has no flow between boxes: its specification is this row and its surface.
- Ruled out: a gesture the maintainer has cut is not in any table. See [Ruling a gesture out](#ruling-a-gesture-out).

A toggle or an opposite pair (enable and disable, move up and move down) is one row with both directions, and both Command IDs. Any other gesture has one Command ID. A gesture that appears on several surfaces has one row, and each surface adapts its own item to the Argument.

## Principles

- Progressive disclosure. A surface shows the common gesture first and asks for the rest when it is needed. A gesture with variants is one gesture with Options. It is not a flat list of near-duplicate menu items.
- The surface supplies the Argument. A picker supplies the Options. A menu on an object passes the object. A palette entry or a keybinding has no clicked row, so the gesture takes the focused view's selection. The gesture asks only for the Options the caller left out. A keybinding, a webview message or an agent call may supply all of them.
- When to group. Variants are one gesture when all four of these hold:
  1. The user names them with the same verb and a qualifier: "copy as", "move to", "open beside".
  2. The Argument has the same shape.
  3. The variants differ along one dimension the user chooses: a mode, a target or a placement.
  4. The result is the same kind of thing.

  A category word such as "edit" fails the first test, so its variants are separate gestures. An opposite pair needs no picker. Gestures that share a flow share a diagram; that does not merge them.
- A gesture is atomic. It does one thing the user intends, however many steps it takes inside. A chain of gestures the user already has, such as installing and then moving, is a script the user writes.
- An all variant is select all, then the gesture. A gesture over a selection needs no second gesture for everything.
- Entry points are not gestures. Every gesture is a command. The palette lists it, and the user can bind a key to it. A menu item, a default key or a mouse click is an entry point to the same command, not a second gesture. Where VS Code gives an entry point no way to pass an Option or name its view, the entry point is an internal command that fires the gesture with them. It is not a gesture: the catalog does not list it, and it has no palette entry.
- An entry point fires a gesture. A gesture does not fire another. An entry point may fire any gesture through the command registry. It passes the Argument and uses no result, as a click on a plugin row opens its header. A gesture that acts on another box's outcome calls that box through a project reference.
- One identity. The Command ID is the identity of a gesture. The Gesture column is the verb the user sees for it, and the palette title is that verb plus the object ("Modbench: Rename Mod"), or the verb alone for a gesture in Every view ("Modbench: Copy Value"). Keep the ID's verb and the user's verb the same words. Prefer existing software-development language, and keep both short. A verb that needs more than three words means the concept lacks a term, so define the term first.
- No dead entries. A gesture that is not available, or not applicable, is not shown. It is never shown and then refused for that reason. A gesture that is offered and then cannot proceed still refuses, and says why (see the next principle).
- Refuse, do not repair. When a gesture cannot proceed, it says why and stops. The user fixes the cause and tries again.
- A gone object is refused. A gesture whose object has gone from disk is refused, and the refusal names it.
- A failed gesture writes nothing. When a command cannot finish, it leaves the files as they were and reports the failure ([ADR-0019](../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md)). A surface story names any gesture that cannot promise this.
- A selection is one gesture, and each item lands on its own. A gesture over several objects is one command with the whole selection as its Argument, asked once. An item that cannot proceed writes nothing and is refused, naming why; the others land. The result names both ([ADR-0019](../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md)). A cause that no item can escape, such as git missing from the PATH, refuses the whole selection once, before any item is written.
- Esc changes nothing. Cancelling a pick or a prompt ends the gesture with no write and no message.
- Confirm what destroys. A gesture that deletes an object, or replaces a whole object, asks first. It asks once for the whole selection. An edit to a value inside a record changes the record and deletes nothing, so it does not ask. No other gesture asks. A surface can name an exception, with its reason.
- A gesture that writes ends when the read model shows it. It writes its file and keeps no copy of the new state. The view then asks for a read, and the gesture ends when the read model shows the change. A selection writes every item, then asks for one read. The read model's value always wins, except in a file's own editor, which shows its document until it is saved (ADR-0001).
- A gesture on plugin source edits its documents and saves them: mEdit answers the changes, and VS Code applies them as one workspace edit, open documents included. Every other gesture writes through a repository. Nothing a gesture touches is left unsaved.
- Doing nothing is not an error. A gesture whose result equals the current state writes nothing and says nothing.
- No lifecycle gestures for mEdit. The backend starts with the extension. No gesture starts, stops or reloads it.
- One filter. Every list has the same name filter (common.md, The name filter).

## Chrome

Rules for the title bar of a view.

- A view shows at most four icons, and a filter and its clear count as one.
- An icon is earned. A state readout or a common toggle keeps one. A configure-once gesture goes in the overflow.
- A destructive gesture never gets an icon. It sits in the overflow, behind a confirmation.
- The order is the name filter, the view's state toggle, domain gestures, the overflow, and Collapse All last. Collapse All is on trees only.
- An action that is not about a tree's own object goes on the Toolbox, the status bar or the palette.

## Ruling a gesture out

A template is a standalone program. Modbench is not. A gesture leaves this file for one of these reasons, and each reason is a row in the summary table of [xedit.md](../out-of-scope/xedit.md) or [mo2.md](../out-of-scope/mo2.md):

- VS Code provides it. Settings, editor history, the file tab, tasks, Problems and Output.
- Standalone application. The template manages its own startup, save or options.
- An ADR decides it. A decision makes the gesture meaningless, or forbids it.
- Game-specific. It serves one or two games, or one engine.
- Scripts, tasks or the agent. The operation is multi-step, and it is not a gesture.
- Platform. The template relies on something Modbench lacks, such as a virtual file system.
- Metadata chrome. It annotates or organizes a list, and nothing in Modbench consumes it.
- Backups belong to git.
- Manual file management. It is a compound file operation, and the user does it by hand in VS Code.
- Maintainer ruling. The gesture is unnecessary, and its register row says why.
- Dead in the template. It has no working handler there.

A gesture that fits none of these stays in the tables. A new reason is added to the summary table first. The file for that template lists the gesture with its reason.

## Surfaces and their templates

| Surface | xEdit template | MO2 template | What it shows |
|---|---|---|---|
| Toolbox | main menu | toolbar, run box, profile combo | [toolbox.md](surfaces/toolbox.md) |
| Mods | - | mod list | [mods.md](surfaces/mods.md) |
| Plugins | navigator | plugin list | [plugins.md](surfaces/plugins.md) |
| Downloads | - | Downloads tab | [downloads.md](surfaces/downloads.md) |
| Editor | View grid, Referenced By | - | [editor.md](surfaces/editor.md) |
| Plugin source | Referenced By, Ctrl + click | - | [plugin-source.md](surfaces/plugin-source.md) |

The xEdit Messages tab is not a surface. Failures go to the Output and the surface their severity calls for (ADR-0019); diagnostics go to the Problems panel.

## Where surfaces live

| Surface | Container | Order | Default |
|---|---|---|---|
| Toolbox | Activity Bar (`modbench`) | 1 | open |
| Mods | Activity Bar | 2 | open |
| Plugins | Activity Bar | 3 | open |
| Downloads | Activity Bar | 4 | collapsed |
| Editor, the record panel | an editor tab | - | opened by the user |
| Editor, Referenced By | Panel (`modbenchReferencedBy`) | - | follows the active record |
| Mods, the conflict table | an editor tab | - | opened by the user |
| Plugin source, the text editor | an editor tab | - | opened by the user |

No view defaults to the Secondary Side Bar: it is the home of chat. A user can still move any view there.

Every view is always present. A view with nothing to show renders its own empty state, and no view hides itself. Referenced By is a Panel view because it follows the active record, and a sidebar view cannot sit beside an editor tab.

## Every view

What every list view does to whatever it shows, whatever the object. common.md says how each behaves, and each surface says what its rows copy. The Toolbox is a readout, not a list, and offers neither.

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| copy value | reads | `modbench.copyValue` | selection | - | MO2 mod list, plugin list and Downloads; xEdit navigator, Referenced By and View grid | Copy the selection to the clipboard as text, one item to a line, each as its surface says. | none |
| filter | reads | `modbench.filter`, `modbench.clearFilter` | - | - | MO2 mod list, plugin list and Downloads; xEdit navigator and Referenced By | Narrow the focused list by name. | none |

## Instance

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| open settings | reads | `modbench.settings.open` | - | - | MO2 toolbar | Open VS Code's Settings editor, filtered to Modbench's settings. | none |
| refresh | writes | `modbench.instance.refresh` | - | - | MO2 toolbar | Drop and rebuild the index, then re-read the instance from disk. One gesture for all of Modbench. It is a safety net, not how changes normally arrive. It is refused while another window holds the index. | load-instance |

## Profile

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| switch | writes | `modbench.profile.switch` | profile | - | MO2 profile combo | Change the active MO2 profile. With no Argument, a picker lists the profiles. | update-load-order-file |

## Mod

The Overwrite row is a mod-list row, not a mod; its `Argument` is `overwrite`.

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| enable / disable | writes | `modbench.mod.enable`, `modbench.mod.disable` | mods | - | MO2 mod list | Flip each mod's line in `modlist.txt`. Enable all is select all, then this gesture. | update-load-order-file |
| move | writes | `modbench.mod.move` | mods or separators | target: a separator, above a mod, or the view's end | MO2 mod list | Move mods in mod order. | update-load-order-file |
| uninstall | writes | `modbench.mod.uninstall` | mods | - | MO2 mod list | Move a mod folder to the trash and remove its line. | update-load-order-file |
| create empty mod | writes | `modbench.mod.createEmpty` | - | name | MO2 mod list | Create an empty mod folder and its line. | update-load-order-file |
| install | writes | `modbench.mod.install` | source: archive, folder or downloaded file | target mod, for an upgrade | MO2 mod list; MO2 Downloads | Install a source as a new mod, or over an installed mod as an upgrade. | install-mod |
| track | writes | `modbench.mod.track` | mods | - | none | Put a mod under git: a repository holding its plugin source, in one commit. On a plugin row or an Editor column, it acts on the plugin's mod. | decompile-plugin |
| sort direction | reads | `modbench.mod.sortWinningAtTop`, `modbench.mod.sortLosingAtTop` | - | - | MO2 mod list | List mods with the winning end at the top or at the bottom. | none |
| open folder | reads | `modbench.mod.openFolder` | mod, or overwrite, or a file or folder in one | - | MO2 mod list, Overwrite row | Show a mod's folder, or a file or folder in it, in VS Code's Explorer. The Overwrite row opens the overwrite folder. | none |
| view on Nexus | reads | `modbench.mod.viewOnNexus` | mod, or downloaded file | - | MO2 mod list; MO2 Downloads | Open the mod's Nexus page. The address comes from the mod's `meta.ini`, or from the downloaded file's `.meta`. | none |
| open conflicts | reads | `modbench.mod.openConflicts` | mod | - | MO2 Information dialog, Conflicts tab | Open a mod's conflict table in an editor tab. | open-conflicts |
| compare file | reads | `modbench.mod.compareFile` | a copy of a file in a mod or Overwrite | - | none | Open VS Code's diff editor on a mod's copy of a file and the winning copy. | none |
| go to mod | reads | `modbench.mod.goToMod` | a copy of a file in a mod or Overwrite | other mod: a pick, when the copy wins over several | MO2 Information dialog, Conflicts tab, Go to... | Select, in Mods, the mod or Overwrite whose copy wins the file, or a mod whose copy it wins over. | none |
| exclude / include file | writes | `modbench.mod.excludeFile`, `modbench.mod.includeFile` | files in mods or Overwrite | - | MO2 Information dialog, Conflicts tab, Hide; MO2 mod list, Restore hidden files | Keep each file from the game by renaming it with MO2's `.mohidden` suffix, or restore its name. | update-load-order-file |
| rename | writes | `modbench.mod.rename` | mod | name | MO2 mod list | Rename a mod's folder and its name in every profile's `modlist.txt`. | update-load-order-file |

## Separator

A separator is a row in mod order.

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| add | writes | `modbench.separator.add` | mod or separator (the anchor) | position: above a mod, and the mod joins the new separator; below a separator, after its mods | MO2 mod list | Add a mod separator next to a mod or a separator. | update-load-order-file |
| rename | writes | `modbench.separator.rename` | separator | - | MO2 mod list | Rename a mod separator. | update-load-order-file |
| delete | writes | `modbench.separator.delete` | separators | - | MO2 mod list | Delete a mod separator. The mods under it join the separator above, or become ungrouped when it was the first. | update-load-order-file |

## Plugin

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| enable / disable | writes | `modbench.plugin.enable`, `modbench.plugin.disable` | plugins | - | MO2 plugin list | Flip each plugin's line in `plugins.txt`. Enable all is select all, then this gesture. | update-load-order-file |
| move | writes | `modbench.plugin.move` | plugins | target: the row it is dropped on, or the view's end. Several plugins move as one block | MO2 plugin list | Move plugins in plugin order. Masters stay above their dependants, and blueprint plugins stay last. | update-load-order-file |
| create | writes | `modbench.plugin.create` | - | place: Overwrite or an enabled mod | xEdit navigator | Create an empty plugin in Overwrite or in a mod. | create-plugin |
| compile | writes | `modbench.plugin.compile` | plugins | - | xEdit main menu | Write the plugin's binary from its plugin source. | compile-plugin |
| decompile | writes | `modbench.plugin.decompile` | plugins | - | none | Read each plugin's bytes into its plugin source, in the working tree of the checked-out branch. It commits nothing. | decompile-plugin |
| sort direction | reads | `modbench.plugin.sortWinningAtTop`, `modbench.plugin.sortLosingAtTop` | - | - | MO2 plugin list | List plugins with the winning end at the top or at the bottom. | none |
| reveal | reads | `modbench.plugin.reveal` | plugin | - | MO2 plugin list | Show a plugin file in the system's file manager. | none |
| rename | writes | `modbench.plugin.rename` | plugin | name | none | Rename a tracked plugin: its file, its plugin source and its line in every profile's `plugins.txt`. | rename-plugin |

## Record

A field gesture from the palette acts on the focused cell of the record tab in focus, and is in the palette only while one has focus.

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| edit field | edits | `modbench.record.editField` | record, plugin, field path | value: set, paste, or the value of another field by drag and drop | xEdit View grid; xEdit drag between columns | Change a field's value in plugin source. A plugin header is a record, and its fields are editable the same way. | edit-record |
| add element | edits | `modbench.record.addElement` | array | value (a drop supplies it; otherwise a new element) | xEdit View grid | Add an element to an array field. | edit-record |
| remove element | edits | `modbench.record.removeElement` | element | - | xEdit View grid | Remove an element from an array field. | edit-record |
| move element | edits | `modbench.record.moveElementUp`, `modbench.record.moveElementDown` | element | - | xEdit View grid | Move an element one step in an array field. | edit-record |
| create | edits | `modbench.record.create` | plugin, or a container record | record type; grid position, for an exterior cell | xEdit navigator | Add a record to a plugin, or a child record to a record. | edit-record |
| delete | edits | `modbench.record.delete` | records | - | xEdit navigator, Referenced By, View header | Remove records from a plugin. The confirmation lists everything selected. | edit-record |
| copy | edits | `modbench.record.copy` | records | mode: new or override; destination plugins; replace, for a destination that holds the record | xEdit navigator, Referenced By, View header; xEdit Inject Forms into master... | Copy records into other plugins. A picker asks for the mode and another for the destination. If a destination already holds a copy, a confirmation asks whether to replace it. | edit-record |
| open | reads | `modbench.record.open` | records, or a reference field | placement: beside | xEdit navigator; xEdit Referenced By; xEdit Compare Selected; xEdit Ctrl + click | Open a record in an editor tab. Several records open one grid: the first record's file, with the others as its columns. A plugin header is a record. The Go to Record menu item on a reference field opens the record it points to. With no Argument, a picker finds a record by EditorID, FormID or FormKey. | query-index |
| open field value | reads | `modbench.record.openFieldValue` | record, plugin, field path | - | xEdit View grid | Open a field value in an editor tab. | none |
| filter | reads | `modbench.record.filter`, `modbench.record.clearFilter` | - | query: a `.sql` file, or a new document | xEdit navigator | Narrow the record tree to the FormKeys a SQL query returns. | query-index |

## Referrer

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| sort direction | reads | `modbench.referrer.sortAscending`, `modbench.referrer.sortDescending` | - | - | xEdit Referenced By | List referrers by record type, then label, or in reverse. | none |

## Downloaded file

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| exclude / include | writes | `modbench.downloadedFile.exclude`, `modbench.downloadedFile.include` | downloaded files | - | MO2 Downloads | Mark downloaded files excluded in their `.meta`, or clear the mark. `show excluded` decides whether the list shows them. | update-load-order-file |
| delete | writes | `modbench.downloadedFile.delete` | downloaded files | - | MO2 Downloads | Delete downloaded files. | update-load-order-file |
| open | reads | `modbench.downloadedFile.open` | downloaded file | - | MO2 Downloads | Open a downloaded file in its system application. | none |
| open `.meta` | reads | `modbench.downloadedFile.openMeta` | downloaded file | - | MO2 Downloads | Open a downloaded file's `.meta` in an editor tab. | none |
| sort | reads | `modbench.downloadedFile.sort` | - | field | MO2 Downloads | Choose the field the downloaded files sort by. | none |
| show excluded | reads | `modbench.downloadedFile.showExcluded`, `modbench.downloadedFile.hideExcluded` | - | - | MO2 Downloads | Show or hide the excluded downloaded files. | none |

## System commands

Commands Modbench runs itself. No user starts them and no surface owns them, so they have no gesture and sit outside the object tables. The first column is the trigger that fires each one. Each is a command for the same reason a gesture is: one handler, and one identity. Each is internal: registered under its Command ID, with no entry point and no palette entry. A system command keeps the disk and mEdit in line with the instance value. It takes the value, or the slice it needs, as its Argument.

| Trigger | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| The Instance loader recomputed the instance value ([load-instance](traces/load-instance.d2)), or mEdit started | writes | `modbench.instance.putLoadOrder` | snapshot: the game release, every plugin in the instance and what provides it, and the active plugins in load order | - | none | Hand mEdit the whole snapshot at every recompute. | index-load-order |
| The active profile's `modlist.txt` disagrees with `mods/`: a folder with no line, or a line whose folder is gone | writes | `modbench.mod.sync` | instance value | - | MO2 refresh | Bring the active profile's `modlist.txt` into line with `mods/`: add a line for each folder that has none, and drop each line whose folder is gone. One write. | update-load-order-file |
| The active profile's `plugins.txt` disagrees with the plugins provided, a plugin file where the game can load it from: an enabled mod, Overwrite or the game folder: a plugin with no line, or a line that nothing provides | writes | `modbench.plugin.sync` | instance value | - | MO2 refresh | Bring `plugins.txt` into line with the plugins provided: add a line at the winning end, disabled, for each plugin that has none, and drop each line that nothing provides. One write. | update-load-order-file |