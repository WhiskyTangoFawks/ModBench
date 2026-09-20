# Commands

This file owns the UX vocabulary and the catalog of gestures. `CONTEXT.md` owns the domain
vocabulary. A gesture or command the code has and this file lacks is a defect in the code.
A gesture this file has and the model cannot hold is a ticket.

- **Object**: a domain noun the user acts on: Instance, Profile, Mod, Separator, Plugin, Record,
  Downloaded file. `CONTEXT.md` defines each one.
- **Surface**: what a driving box presents to the user. One surface per driving box on the
  Modbench side. A surface shows objects and offers their gestures. A VS Code view or an editor
  realizes it.
- **Gesture**: one thing the user does to an object. One row in the tables below, under the
  object it changes.
- **System command**: a command Modbench runs itself, with trigger `automatic`. No user starts it and
  no surface owns it. It has its own section, after the objects.
- **Offered on**: the surfaces where a gesture appears. It states the model, not the code.
- **Effect**: `writes` when the gesture ends in a Core command that writes a file, a repository
  or a folder. `reads` when it only changes what the surface shows, or opens something. `runs`
  when it starts another program and writes nothing itself.
- **Trigger**: how the gesture starts. One of `menu`, `key`, `check box`, `drag`,
  `webview message`, `dialog answer`, `code action`, `automatic`.
- **Command ID**: the `modbench.*` entry the gesture registers, or `-` if it has none. A row that
  lists more than one, other than a toggle or an opposite pair, is `debt`. So is a row whose
  Command ID or code name does not match the gesture's name.
- **Options**: the inputs a gesture needs besides its Argument, such as a mode, a destination or a
  position. A picker asks for each Option the caller did not supply.
- **Argument**: the value that identifies the object or objects to the gesture, such as a plugin
  name or a FormKey. For a gesture that creates an object, it identifies the container. It is
  the same on every surface that offers the gesture. A handler that receives anything else is
  `debt`.
- **Template**: the xEdit ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md))
  or MO2 ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)) gesture this row
  follows, read from [the xEdit audit](../research/xedit-surface-audit.md),
  [the xEdit grid audit](../research/xedit-ux-audit.md) and
  [the MO2 audit](../research/mo2-surface-audit.md). `none` means the template has no such
  gesture: the row is an addition or a divergence, and needs a ruling.
- **Trace**: the sequence diagram of the gesture's family. A gesture that is not built has none,
  because drawing the trace is part of designing the gesture. A built gesture with `-` has a trace
  still to draw.
- **Ruled out**: a gesture the maintainer has cut is not in any table. See
  [Ruling a gesture out](#ruling-a-gesture-out).

A toggle or an opposite pair (enable and disable, move up and move down) is one row with both
directions, and both Command IDs. Any other gesture has one Command ID. A gesture that appears on several surfaces has one row, and each surface adapts its
own item to the Argument.

Status: `built`, `drawn` (in the zoom-out and a trace, not built), `planned`, `word-only`, `?`
(not verified), or `debt #NNN` (the code breaks this model, and the ticket names the fix).

## Principles

- **Progressive disclosure.** A surface shows the common gesture first and asks for the rest when
  it is needed. A gesture with variants is one gesture with Options. It is not a flat list of
  near-duplicate menu items.
- **The surface supplies the Argument. A picker supplies the Options.** A menu on an object passes
  the object. The gesture asks only for the Options the caller left out. A keybinding, a webview
  message or an agent call may supply all of them.
- **One command per gesture.** A toggle or an opposite pair registers one for each direction.
- **Entry points are not gestures.** Every gesture is a command. The palette lists it, and the user
  can bind a key to it. A menu item, a default key or a mouse click is an entry point to the same
  command, not a second gesture.
- **One name.** A gesture's name is one to three words and is unique in this catalog. Add the
  object only where the bare verb collides. Prefer existing software-development language. It is the
  name in the architecture, the Command ID and the core handler; UI text may differ. A name that
  needs more than three words means the concept lacks a term, so define the term first. A name that
  differs anywhere is `debt`.

  A category word such as "edit" fails the first test, so its variants are separate gestures. An
  opposite pair is one row with two entries, and it needs no picker.

## Ruling a gesture out

A template is a standalone program. Modbench is not. A gesture leaves this file for one of these
reasons, and each reason is a row in the summary table of [xedit.md](../out-of-scope/xedit.md) or
[mo2.md](../out-of-scope/mo2.md):

- **VS Code provides it.** Settings, editor history, the file tab, tasks, Problems and Output.
- **Standalone application.** The template manages its own startup, save or options.
- **An ADR decides it.** A decision makes the gesture meaningless, or forbids it.
- **Game-specific.** It serves one or two games, or one engine.
- **Scripts, tasks or the agent.** The operation is multi-step, and it is not a gesture.
- **Platform.** The template relies on something Modbench lacks, such as a virtual file system.
- **Metadata chrome.** It annotates or organizes a list, and nothing in Modbench consumes it.
- **Backups belong to git.**
- **Manual file management.** It is a compound file operation, and the user does it by hand in VS Code.
- **Maintainer ruling.** The gesture is unnecessary, and the ledger says why.
- **Dead in the template.** It has no working handler there.

A gesture that fits none of these stays in the tables. A new reason is added to the summary table
first. The file for that template lists the gesture with its reason.

## Surfaces and their templates

| Surface | xEdit template | MO2 template |
|---|---|---|
| Toolbox | main menu | toolbar, run box, profile combo |
| Mods | - | mod list |
| Plugins | navigator | plugin list |
| Downloads | - | Downloads tab |
| Editor | View grid, Referenced By | - |

The xEdit Messages tab is not a surface. Failures go to the Problems panel (ADR-0019).

## Instance

Offered on Toolbox. Run entries are not an object yet; the run-list gestures name them `run entry`.

| Gesture | Effect | Trigger | Offered on | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|---|
| deploy / purge | writes | menu | Toolbox | `modbench.toolbox.deploy`, `modbench.toolbox.purge` | - | - | none | Toggle between deployed and not deployed. Purge asks for confirmation. Deploy is a state, separate from `run`, and purge never runs on its own. | ? | deploy |
| run | runs | menu | Toolbox | `modbench.toolbox.launch` | run entry | - | MO2 run box: Run | Start the game or another executable from MO2's run list, as a VS Code task. | debt #956 | - |
| select game | ? | ? | Toolbox | ? | game | - | MO2 toolbar: Manage Instances (closest) | Choose the game the instance is for. | ? | - |
| open settings | reads | ? | Toolbox | ? | - | - | MO2 toolbar: Settings | Open the Modbench settings. | ? | - |
| refresh | writes | menu | Toolbox | `modbench.refresh` | - | - | MO2 toolbar: Refresh (F5) | Drop and rebuild the index and re-read every source from disk. One gesture for all of Modbench. It is a safety net, not how changes normally arrive. It is refused while another window holds the index. | built (?) | the-instance-recomputes |
| add executable | writes | menu | Toolbox | - | run entry | - | MO2 Executables dialog: Add | Add an executable to the run list in `ModOrganizer.ini`, as a task. | planned | - |
| remove executable | writes | menu | Toolbox | - | run entries | - | MO2 Executables dialog: Remove | Remove an executable from the run list. | planned | - |
| edit executable | writes | menu | Toolbox | - | run entry | field | MO2 Executables dialog: edit fields | Change the fields of a run-list entry. Reordering and resetting the list are open. | planned | - |
| set up instance | writes | menu | Toolbox | - | instance | - | none | Create `mods/`, `profiles/`, `modlist.txt` and the config for a new instance. | planned | - |
| track modlist | writes | ? | ? | - | instance | - | none | Put the modlist under git, and rebuild it from git state and download targets. The design is open. | planned | - |
| log in | writes | dialog answer | Toolbox | - | - | - | MO2 settings: Nexus | Store a Nexus API key in VS Code's secret storage. | planned | - |
| run script | runs | menu | ? | - | script | debug | xEdit navigator: Apply Script... | Run a Python script over the load order, a record or a plugin. Option: run it under the debugger. | planned | - |
| cancel | ? | menu, key | Toolbox, Downloads | - | a running operation: a download, Track, a large copy | - | MO2 Downloads: Cancel | Stop a running operation. | planned | - |

## Profile

Offered on Toolbox. A Profile is part of the Instance.

| Gesture | Effect | Trigger | Offered on | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|---|
| switch profile | writes | menu | Toolbox | `modbench.toolbox.switchProfile` | profile | - | MO2 profile combo | Change the active MO2 profile. | ? | switch-profile |
| create profile | writes | dialog answer | Toolbox | ? | source profile, or none | - | MO2 Profiles dialog: Create, Copy | Create a profile, empty or copied from another. | planned | - |

## Mod

Offered on Mods, and on Downloads for install. The Overwrite row is a mod-list row, not a mod; its `Argument` is `overwrite`.

| Gesture | Effect | Trigger | Offered on | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|---|
| enable / disable mod | writes | check box, key, menu | Mods | - | mods | - | MO2 mod list: check box, Space, Enable / Disable selected, All Mods | Flip each mod's line in `modlist.txt`. Enable all is select all, then this gesture. | ? | enable-a-mod |
| move mod | writes | drag, key, menu | Mods | `modbench.modList.mod.moveToSeparator` | mods or separators | target: a separator (built); top, bottom, priority N, first or last conflict (planned) | MO2 mod list: drag, Ctrl+Up / Down, Send to... | Move mods in mod order. | debt #956 | enable-a-mod |
| uninstall | writes | menu | Mods | `modbench.modList.mod.uninstall` | mods | - | MO2 mod list: Remove Mod..., Delete | Remove a mod folder and its line. | ? | - |
| rename mod | writes | menu, key | Mods | - | mod | - | MO2 mod list: Rename Mod..., F2 | Rename a mod's folder and its name in every profile's `modlist.txt`. | planned | - |
| create empty mod | writes | menu | Mods | `modbench.modList.newEmptyMod` | - | position (planned) | MO2 mod list: Create empty mod | Create an empty mod folder and its line. | ? | - |
| install | writes | menu | Mods, Downloads | `modbench.modList.installFromArchive`, `modbench.modList.installFromFolder`, `modbench.downloads.install` | source: archive, folder or downloaded file | position (planned); target mod, for an upgrade; reinstall from the recorded archive (planned); installer: quick, manual or FOMOD (planned) | MO2 mod list: Install mod..., drag; Downloads: Install | Install a source as a new mod, or over a mod with the same Nexus id when the user confirms the target. That is an upgrade. A downloaded file supplies its own source; the Mods menu asks for one. | debt #959 | install-a-mod, upgrade-a-mod |
| open details | reads | menu, double click | Mods, Plugins | - | mod, separator, or a plugin's origin mod | tab | MO2 mod list: Information...; plugin list: Open Origin Info... | Open the mod details view. Its conflicts tab lists the conflicting mods and opens each one. | planned | - |
| highlight conflicts | reads | automatic | Mods, Plugins | - | mods | - | MO2 mod list: conflict markers follow the selection | Mark the mods that conflict with the selection. | planned | - |
| exclude / include mod file | writes | menu | Mods | - | files in a mod | - | MO2 Information dialog, Conflicts tab: Hide; mod list: Restore hidden files | Keep a file out of the deployed Data folder by renaming it with MO2's `.mohidden` suffix, or restore it. It does not change what any list shows. | planned | - |
| check for updates | writes | menu | Mods | - | mods (all, or the selection) | - | MO2 mod list: Check for updates | Ask Nexus for the latest version of each mod and set the update badge. | planned | - |
| track mod | writes | menu | Plugins, Editor | `modbench.pluginListTree.track` | mod | preset: Edits or Everything | none | Put the mod's plugins under git. It fires `decompile plugin` with a new repository as the destination: it creates the repository, commits the baseline to `main` and checks out the edit branch. | debt #966 | decompile-a-plugin |
| rebase edit branch | writes | menu | Plugins | `modbench.pluginListTree.rebase` | tracked mod | - | none | Replay the edit branch onto `main`. | built | a-tracked-mod-changes-on-disk |
| sort direction | reads | menu | Mods | `modbench.modList.view.winningAtTop`, `modbench.modList.view.losingAtTop` | - | - | MO2 mod list: Priority column sort | List mods with the winning end at the top or at the bottom. | built | - |
| filter mods | reads | menu, key | Mods | `modbench.modList.filter`, `modbench.modList.clearFilter` | - | - | MO2 mod list: filter box | Narrow the mod list by name. | built | - |
| open mod folder | reads | menu | Mods | `modbench.modList.mod.openInExplorer` | mod | - | MO2 mod list: Open in Explorer | Show a mod's files in the native file tab, decorated by conflict status (planned; today the file explorer). | built | - |
| open overwrite folder | reads | menu | Mods | `modbench.modList.overwrite.reveal` | overwrite | - | MO2 mod list, Overwrite row: Open in Explorer | Show the overwrite folder in the file explorer. | debt #956 | - |
| view on Nexus | reads | menu | Mods, Downloads | `modbench.modList.mod.viewOnNexus`, `modbench.downloads.visitNexus` | mod, or downloaded file | - | MO2 mod list: Visit on Nexus; MO2 Downloads: Visit on Nexus | Open the mod's Nexus page. The address comes from the mod's `meta.ini`, or from the downloaded file's `.meta`. | debt #956 | - |
| publish | writes | menu | Mods | - | mod | - | none | Publish an update for a mod the user owns, through the Nexus API. | planned | - |

## Separator

Offered on Mods. A separator is a row in mod order.

| Gesture | Effect | Trigger | Offered on | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|---|
| add separator | writes | menu | Mods | `modbench.modList.mod.addSeparatorBelow`, `modbench.modList.separator.addSeparatorBelow` | mod or separator (the anchor) | position: below (built); above, inside (planned) | MO2 mod list: Create separator | Add a mod separator next to a mod or a separator. | debt #960 | enable-a-mod |
| rename separator | writes | menu | Mods | `modbench.modList.separator.rename` | separator | - | MO2 mod list: Rename Separator..., F2 | Rename a mod separator. | ? | enable-a-mod |
| delete separator | writes | menu | Mods | `modbench.modList.separator.delete` | separators | - | MO2 mod list: Remove Separator... | Delete a mod separator. The mods under it join the separator above, or become ungrouped when it was the first. | ? | enable-a-mod |

## Plugin

Offered on Plugins. The Plugins surface shows a plugin's origin mod, so it offers the reduced mod set: open the origin folder and the origin's information. Tracking gates every edit. An untracked plugin is read-only in the Editor, which names Track, so `track mod` is offered where the user meets that refusal.

| Gesture | Effect | Trigger | Offered on | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|---|
| enable / disable plugin | writes | check box, key, menu | Plugins | - | plugins | - | MO2 plugin list: check box, Space, Enable / Disable selected, Enable all | Flip each plugin's line in `plugins.txt`. Enable all is select all, then this gesture. | ? | enable-a-plugin |
| move plugin | writes | drag, key, menu | Plugins | - | plugins | target: top, bottom, priority N (planned). Several plugins move as one block (planned) | MO2 plugin list: drag, Ctrl+Up / Down, Send to... | Move plugins in plugin order. Masters stay above their dependants, and blueprint plugins stay last. | ? | enable-a-plugin |
| create plugin | writes | menu | Plugins | `modbench.newPlugin` | mod | - | xEdit navigator: Create New File... | Create a plugin in a mod. | debt #956 | - |
| compile | writes | menu | Plugins, Editor | `modbench.saveAndCompile`, `modbench.pluginListTree.compileAtMain` | plugin | source: working tree, or `main` | xEdit main menu: Save (closest) | Write the plugin's binary from its plugin source. The previous binary is kept as a `.bak` while compiling, and restored if the compile fails. | debt #961 | compile-a-plugin |
| repair | writes | menu | Plugins | - | plugin | - | none | Rewrite a malformed plugin into its canonical form. | planned | - |
| validate | reads | menu, automatic | Plugins, Toolbox | - | plugins, or the instance | check kinds | xEdit navigator: Check for Errors, Check for circular leveled lists | Report problems in the Problems panel: structural, load order, missing assets. | planned | - |
| filter plugins | reads | menu, key | Plugins | `modbench.pluginListTree.filter`, `modbench.pluginListTree.clearFilter` | - | - | MO2 plugin list: filter box; xEdit navigator: filename filter | Narrow the plugin list by name. | built | - |
| reveal plugin | reads | menu | Plugins | `modbench.pluginListTree.revealInExplorer` | plugin | - | MO2 plugin list: Open Origin in Explorer | Show a plugin file in the file explorer. | built | - |
| highlight origin | reads | automatic | Plugins, Mods | - | plugins, or mods | - | MO2 plugin list: selecting a plugin highlights its origin mod and masters | Selecting a plugin marks its origin mod and its masters. Selecting a mod marks the plugins it provides. | planned | - |
| add sort rule | writes | menu | Plugins | - | - | rule | none | Add a plugin sorting rule. A hard rule is red and a soft rule is yellow. | planned | - |
| edit sort rule | writes | menu | Plugins | - | sort rule | field | none | Change a sorting rule. | planned | - |
| enable / disable sort rule | writes | menu | Plugins | - | sort rules | - | none | Turn a sorting rule on or off. | planned | - |
| remove sort rule | writes | menu | Plugins | - | sort rules | - | none | Remove a sorting rule. | planned | - |
| apply suggested sort | writes | code action | Plugins | - | plugin | - | none | Fix a sorting problem by applying the suggested position. The problem shows as a squiggle. | planned | - |
| rename plugin | writes | menu | Plugins | - | plugin | new name | none | Rename a plugin, its source tree and the master reference in every dependent. | planned | - |
| relink source | writes | dialog answer | Plugins | - | plugin | - | none | A plugin was renamed outside Modbench: move its source tree to the new name. | planned | - |
| remove source | writes | dialog answer | Plugins | - | plugin | - | none | A plugin was deleted outside Modbench: remove its source tree, as a working-tree deletion the user reviews. | planned | - |

## Record

Offered on Plugins (the record children) and on Editor (the record panel and Referenced By). Following xEdit, create, renumber and filter are Plugins only; field gestures are Editor only; the rest are on both.

| Gesture | Effect | Trigger | Offered on | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|---|
| edit field | writes | webview message, key, drag | Editor | - | record, field path | value: set, paste, or the value of another field by drag and drop | xEdit View grid: inline edit, Clear, Ctrl+V; drag between columns | Change a field's value in plugin source. A plugin header is a record, and its fields are editable the same way (planned). | ? | edit-a-record |
| add element | writes | menu, key | Editor | `modbench.array.add` | array | - | xEdit View grid: Add, Insert | Add an element to an array field. Sorted arrays add too (planned). | built | edit-a-record |
| remove element | writes | menu, key | Editor | `modbench.array.remove` | element | - | xEdit View grid: Remove, Delete | Remove an element from an array field. Sorted arrays remove too (planned). | built | edit-a-record |
| move element | writes | menu, key | Editor | `modbench.array.moveUp`, `modbench.array.moveDown` | element | - | xEdit View grid: Move Up, Move Down, Ctrl+Up / Down | Move an element one step in an unsorted array. Sorted arrays have no move. | built | edit-a-record |
| create record | writes | menu | Plugins | `modbench.record.create` | plugin, or a container | record type; containment, for a container (planned) | xEdit navigator: Add, Insert | Add a record to a plugin. | built | edit-a-record |
| delete record | writes | menu | Plugins, Editor | `modbench.record.delete` | records | - | xEdit navigator, Referenced By, View header: Remove, Delete | Remove records from a plugin. The confirmation lists everything selected. | built | edit-a-record |
| renumber | writes | menu | Plugins | `modbench.record.renumber` | records, or a plugin | start id, for a plugin (planned) | xEdit navigator: Change FormID, Renumber FormIDs from... | Change a record's FormKey and every reference to it. | built | edit-a-record |
| copy record | writes | menu | Plugins, Editor | `modbench.record.copyAsNewRecord`, `modbench.record.copyAsOverride` | records | mode: new, override, underride (planned); destination plugins; deep, for containers (planned) | xEdit navigator, Referenced By, View header: Copy as ... into...; Inject Forms into master... | Copy records into other plugins. A picker asks for the mode and another for the destination. If a destination already holds a copy, a confirm asks whether to replace it. | debt #962 | edit-a-record |
| open record | reads | menu | Plugins, Editor | `modbench.openEditor`, `modbench.openEditorBeside`, `modbench.openHeader`, `modbench.openCompare` | records, or a reference field | placement: beside | xEdit navigator: select shows the record; Referenced By: Jump to; Compare Selected; Ctrl + click | Open a record in an editor tab. Several records open as a comparison. A plugin header is a record. A reference cell opens the record it points to, by the Go to Record menu item. With no Argument, a picker finds a record by FormID or EditorID. | debt #963 | - |
| open field value | reads | menu | Editor | `modbench.field.openExtended` | record, field path | - | xEdit View grid: double click opens the extended editor | Open a field value in an editor tab. | built | - |
| filter records | reads | menu | Plugins, Editor | `modbench.setFilter`, `modbench.clearFilter`, `modbench.setFilterFromDocument` | - | query source: input box, or a document | xEdit navigator: Apply Filter..., Remove Filter | Narrow the record tree to the FormKeys a SQL query returns. | debt #964 | query |
| show referenced by | reads | automatic | Editor | `modbench.showReferencedBy` | active record | - | xEdit Referenced By tab: shown automatically for the selected record | The Referenced By list follows the active record and shows the records that reference it. It has no menu entry; the command only focuses the view. | built | query |
| hide no-conflict rows | reads | menu | Editor | - | - | - | xEdit View grid: Hide no-conflict rows | Collapse the compare grid to the rows that conflict. A toggle. | planned | - |
| copy value | reads | menu, key | Mods, Plugins, Editor | `modbench.referencedByTree.copy` | selection | text: name, FormKey | xEdit navigator, Referenced By, View grid: Ctrl+C; MO2 mod list: Ctrl+C | Copy the selected rows, or a focused cell value, to the clipboard. | built | - |

## Downloaded file

Offered on Downloads.

| Gesture | Effect | Trigger | Offered on | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|---|
| exclude / include downloaded file | writes | menu | Downloads | `modbench.downloads.hide`, `modbench.downloads.unhide` | downloaded files | - | MO2 Downloads: Hide, Un-Hide | Mark downloaded files hidden in their `.meta`, or restore them. `show excluded` decides whether the list shows them. | debt #956 | - |
| delete downloaded file | writes | menu, key | Downloads | `modbench.downloads.delete` | downloaded files | - | MO2 Downloads: Delete... | Delete downloaded files. | ? | - |
| download | writes | automatic | - | - | - | source: an nxm:// link (planned) | MO2 download manager | Fetch a mod file into `downloads/`. Modbench does not do this yet. | word-only | - |
| pause / resume | writes | menu, key | Downloads | - | downloaded file (a running download) | - | MO2 Downloads: Pause, Resume | Pause a running download, or resume it. | planned | - |
| open file | reads | menu | Downloads | `modbench.downloads.openFile` | downloaded file | - | MO2 Downloads: Open File | Open a downloaded file. | built | - |
| open meta | reads | menu | Downloads | `modbench.downloads.openMeta` | downloaded file | - | MO2 Downloads: Open Meta File | Open the `.meta` sidecar. | built | - |
| query info | writes | menu | Downloads | - | downloaded files | - | MO2 Downloads: Query Info | Look a downloaded file up on Nexus by hash and fill its `.meta`. | planned | - |
| filter downloaded files | reads | menu, key | Downloads | `modbench.downloads.filter`, `modbench.downloads.clearFilter` | - | - | MO2 Downloads: filter box | Narrow the downloaded files by name. | built | - |
| sort downloaded files | reads | menu | Downloads | `modbench.downloads.sortBy` | - | field | MO2 Downloads: column header | Choose the field the downloaded files sort by. | built | - |
| show excluded | reads | menu | Downloads | `modbench.downloads.showHidden`, `modbench.downloads.hideHidden` | - | - | MO2 Downloads: Hidden files check box | Show or hide the excluded downloaded files. | debt #956 | - |
| reveal installed mod | reads | menu | Downloads | - | downloaded file | - | none | Show the mod that a downloaded file was installed as. | planned | - |

## System commands

Commands Modbench runs itself. No user starts them and no surface owns them, so they sit outside the
object tables. Each is a command for the same reason a gesture is: one handler, and a name that
matches everywhere.

| Gesture | Effect | Trigger | Offered on | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|---|
| put load order | writes | automatic | - | - | load order snapshot | - | none | Hand mEdit the whole load order snapshot whenever it changes. The architecture calls it a PUT. | built | enable-a-mod, project |
| import mod | writes | automatic | - | - | folder | - | MO2 refresh (implicit) | Add a line to `modlist.txt` for a folder already in `mods/`. Code name: adopt. | debt #956 | install-a-mod |
| import plugin | writes | automatic | - | - | plugin | - | none | Add a line to `plugins.txt` for a plugin on disk that lacks one. Code name: reconcile. | debt #956 | enable-a-plugin |
| decompile plugin | writes | automatic | - | - | plugins of a tracked mod | destination: `main` when the `meta.ini` version moved (a new release), else the working tree (an edit in another tool); whether it asks first is open | none | The watcher classifies an external change and calls `decompile plugin`, which reads the plugin's bytes back into plugin source. The gesture `track mod` calls the same command with a new repository as the destination. | debt #966 | decompile-a-plugin, a-tracked-mod-changes-on-disk |
