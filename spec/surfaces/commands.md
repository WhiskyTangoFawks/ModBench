# Commands

This file owns the UX vocabulary and the catalog of gestures. `GLOSSARY.md` owns the domain vocabulary. A gesture or command the code has and this file lacks is a defect in the code. A gesture this file has and the model cannot hold is a ticket.

- Object: a domain noun the user acts on: Instance, Profile, Modlist, Mod, Separator, Plugin, Record, Downloaded file. `GLOSSARY.md` defines each one. Settings is Modbench's own configuration, which VS Code stores at user and workspace scope. It is the object of `open settings` only, and `GLOSSARY.md` does not define it, because it is not a domain noun. Modlist is the ordinary word, and `GLOSSARY.md` does not define it either.
- Surface: what the user sees and acts in. It is a Modbench view, or a part of VS Code that Modbench extends, such as the text editor, Source Control or the terminal. A surface shows objects and offers their gestures.
- Gesture: one thing the user does to an object. One row in the tables below, under the object it changes. The Gesture column holds the gesture's verb.
- Exclude and hide: to exclude is to mark an object durably on disk. The mark leaves the object out of something until include clears it, as the Downloads list leaves out an excluded downloaded file. To hide acts on the view alone. It changes nothing on disk and ends with the window, like hide excluded or a name filter.
- System command: a command Modbench runs itself. No user starts it and no surface owns it, so it has no gesture. Its first column is the trigger that fires it. It has its own section, after the objects.
- Where: each surface's Menus and keys lists the gestures it offers, where each sits and on what condition.
- Effect: `writes` when the gesture ends in a Core command that writes a file, a repository, a folder or a secret. `reads` when it only changes what the surface shows, or opens something. `runs` when it starts another program and writes nothing itself. `edits` when the gesture changes plugin source as a VS Code workspace edit and writes nothing itself. Saving the documents writes their files ([ADR-0001](../adr/0001-modbench-is-a-vscode-extension.md)).
- Command ID: the registered interface and the source of truth, which the code reflects. It is `modbench.<object>.<verb>`, in camelCase, and the object owns it (`modbench.mod.enable`, `modbench.downloadedFile.delete`). `-` means the gesture has none. A gesture every list view does to whatever it shows is `modbench.<verb>`, in Every view.
- Options: the inputs a gesture needs besides its Argument, such as a mode, a destination or a position. A picker asks for each Option the caller did not supply. An Option may be computed and multi-valued, such as a checked list with defaults.
- Argument: the value that identifies the object or objects to the gesture, such as a plugin as `(origin, filename)`, or a FormKey. For a gesture that creates an object, it identifies the container, when the entry point is on the container's row. A create from a title icon has none, and its container is an Option. It is the same on every surface that offers the gesture. Singular means the clicked row, and plural means the whole selection.
- Template: the source, xEdit ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md)), MO2 ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)) or git gesture this row follows, read from [the xEdit audit](../../docs/research/xedit-surface-audit.md), [the xEdit grid audit](../../docs/research/xedit-ux-audit.md), [the MO2 audit](../../docs/research/mo2-surface-audit.md). `none` means the template has no such gesture: the row is an addition or a divergence, and needs a ruling.
- Trace: the sequence diagram of the gesture's flow. `-` means the trace is still to draw, and drawing it is part of designing the gesture. `none` means the gesture has no flow between boxes: its specification is this row and its surface.
- Ruled out: a gesture the maintainer has cut is not in any table. See [Ruling a gesture out](#ruling-a-gesture-out).

A toggle or an opposite pair (enable and disable, move up and move down) is one row with both directions, and both Command IDs. Any other gesture has one Command ID. A gesture that appears on several surfaces has one row, and each surface adapts its own item to the Argument.

## Principles

- Progressive disclosure. A surface shows the common gesture first and asks for the rest when it is needed. A gesture with variants is one gesture with Options. It is not a flat list of near-duplicate menu items.
- The surface supplies the Argument. A picker supplies the Options. A menu on an object passes the object. A palette entry or a keybinding has no clicked row, so the gesture takes the focused view's selection. The gesture asks only for the Options the caller left out. A keybinding, a webview message or an agent call may supply all of them.
- When to group. Variants are one gesture when all four of these hold:
  1. The user names them with the same verb and a qualifier: "copy as", "move to".
  2. The Argument has the same shape.
  3. The variants differ along one dimension the user chooses: a mode, a target or a placement.
  4. The result is the same kind of thing.

  A category word such as "edit" fails the first test, so its variants are separate gestures. An opposite pair needs no picker. Gestures that share a flow share a diagram; that does not merge them.
- A gesture is atomic. It does one thing the user intends, however many steps it takes inside. A chain of gestures the user already has, such as installing and then moving, is a script the user writes.
- An all variant is select all, then the gesture. A gesture over a selection needs no second gesture for everything.
- Entry points are not gestures. Every gesture is a command. The palette lists it, and the user can bind a key to it. A menu item, a default key or a mouse click is an entry point to the same command, not a second gesture. Where VS Code gives an entry point no way to pass an Option or name its view, the entry point is an internal command that fires the gesture with them. It is not a gesture: the catalog does not list it, and it has no palette entry.
- An entry point fires a gesture. A gesture does not fire another. An entry point may fire any gesture through the command registry. It passes the Argument and uses no result, as a click on a plugin row opens its header. A gesture that acts on another box's outcome calls that box through a project reference.
- One identity. The Command ID is the identity of a gesture, and keeps the Gesture column's verb. A title or a label is the code's to word: it says truly what the gesture does to what it receives, short, in the reference tool's words where the tool has them. A word borrowed from a tool keeps the meaning it has there: a gesture takes git's word only when it runs that git operation. A verb that needs more than three words means the concept lacks a term, so define the term first.
- No dead entries. A gesture that is not available, or not applicable, is not shown. It is never shown and then refused for that reason. A gesture that is offered and then cannot proceed still refuses, and says why (see the next principle).
- Refuse, do not repair. When a gesture cannot proceed, it says why and stops. The user fixes the cause and tries again.
- A gesture writes nothing that compile refuses. Compile is the one bar on plugin source, and every gesture meets it.
- A gone object is refused. A gesture whose object has gone from disk is refused, and the refusal names it.
- A failed gesture writes nothing. When a command cannot finish, it leaves the files as they were and reports the failure ([ADR-0019](../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md)). A surface story names any gesture that cannot promise this.
- A selection is one gesture, and each item lands on its own. A gesture over several objects is one command with the whole selection as its Argument, asked once. An item that cannot proceed writes nothing and is refused, naming why; the others land. The result names both ([ADR-0019](../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md)). A cause that no item can escape, such as git missing from the PATH, refuses the whole selection once, before any item is written.
- Esc changes nothing. Cancelling a pick or a prompt ends the gesture with no write and no message.
- Confirm what destroys. A gesture that deletes an object, or replaces a whole object, asks first. It asks once for the whole selection. An edit to a value inside a record changes the record and deletes nothing, so it does not ask. No other gesture asks. A surface can name an exception, with its reason.
- Design for the agent. The agent runs a gesture through a request ([agent.md](agent.md)), so a new gesture's design answers four questions in agent.md, where its stories do not already answer them: does the agent run it; what does the agent read before it runs it, as a view shows the user; how does the agent supply what each picker, prompt and confirmation asks; and does the gesture need a force Option, because it can lose what neither git nor the trash keeps.
- A gesture that writes ends when the read model shows it. It writes its file and keeps no copy of the new state. The view then asks for a read, and the gesture ends when the read model shows the change. A selection writes every item, then asks for one read. The read model's value always wins. It reads an unsaved document in place of its file, so a file's own editor and every other view show one value ([ADR-0001](../adr/0001-modbench-is-a-vscode-extension.md)).
- A gesture on plugin source edits its documents: mEdit answers the changes, and VS Code applies them as one workspace edit, as a refactoring, open documents included. VS Code saves them as it saves any refactoring ([ADR-0001](../adr/0001-modbench-is-a-vscode-extension.md)). Every other gesture writes through a repository.
- A compiled plugin is its files. A gesture on its records reads and writes its plugin source, so it works whether the plugin is active or not. Only a judgement against other plugins needs the load order. A plugin that is not active is judged at its line in `plugins.txt`. With no line, no judgement applies, and the gesture lands.
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
| Toolbox | main menu | toolbar, run box, profile combo | [toolbox.md](toolbox.md) |
| Mods | - | mod list | [mods.md](mods.md) |
| Plugins | navigator | plugin list | [plugins.md](plugins.md) |
| Downloads | - | Downloads tab | [downloads.md](downloads.md) |
| Editor | View grid, Referenced By | - | [editor.md](editor.md) |
| Plugin source | Referenced By, Ctrl + click | - | [plugin-source.md](plugin-source.md) |
| Agent | - | - | [agent.md](agent.md) |
| Scripts | Apply Script | - | [scripts.md](scripts.md) |
| Modlist repository | - | - | [modlist-repository.md](modlist-repository.md) |

The xEdit Messages tab is not a surface. Failures go to the Output and the surface their severity calls for (ADR-0019); diagnostics go to the Problems panel.

## Where surfaces live

| Surface | Container | Order | Default |
|---|---|---|---|
| Toolbox | Activity Bar (`modbench`) | 1 | open |
| Mods | Activity Bar | 2 | open |
| Plugins | Activity Bar | 3 | open |
| Downloads | Activity Bar | 4 | collapsed |
| Editor, the record panel | an editor tab | - | opened by the user |
| Editor, Referenced By | VS Code's References view | - | opened by the gesture |
| Mods, the conflict table | an editor tab | - | opened by the user |
| Mods, the FOMOD installer | an editor tab | - | opened by install |
| Plugin source, the text editor | an editor tab | - | opened by the user |
| Modlist repository, the manifests | an editor tab, and Source Control | - | opened by the user |

No view defaults to the Secondary Side Bar: it is the home of chat. A user can still move any view there.

Every view is always present. A view with nothing to show renders its own empty state, and no view hides itself.

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
| log in / log out | writes | `modbench.instance.logIn`, `modbench.instance.logOut` | - | key | MO2 settings, Nexus tab, Enter API Key Manually | Keep my Nexus API key, or forget it. Every gesture that asks Nexus uses it. | none |
| refresh | writes | `modbench.instance.refresh` | - | - | MO2 toolbar | Drop and rebuild the record index, then re-read the instance from disk. One gesture for all of Modbench. It is a safety net, not how changes normally arrive. It is refused while another window holds the record index. | load-instance |

## Profile

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| switch | writes | `modbench.profile.switch` | profile | - | MO2 profile combo | Change the active MO2 profile. With no Argument, a picker lists the profiles. | update-load-order-file |

## Modlist

The instance's mods and profiles as git holds them ([modlist-repository.md](modlist-repository.md)). Commit, branch, merge, log, diff and checkout are VS Code's. A checkout changes the manifests and leaves the mod folders as they were, and restore from manifest restores them.

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| git init | writes | `modbench.modlist.gitInit` | - | - | git init | Make the instance a repository, or adopt the one it holds, with its ignore list, push check and path tokens. It writes no manifest and commits nothing. | init-modlist |

## Mod

The Overwrite row is a mod-list row, not a mod; its `Argument` is `overwrite`.

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| enable / disable | writes | `modbench.mod.enable`, `modbench.mod.disable` | mods | - | MO2 mod list | Flip each mod's enabled state in the active profile. Enable all is select all, then this gesture. | update-load-order-file |
| move | writes | `modbench.mod.move` | mods or separators | target: a separator, above a mod, or the view's end | MO2 mod list | Move mods in mod order. | update-load-order-file |
| uninstall | writes | `modbench.mod.uninstall` | mods | - | MO2 mod list | Move a mod folder to the trash and remove its line and its publisher tags. | update-load-order-file |
| create empty mod | writes | `modbench.mod.createEmpty` | - | name | MO2 mod list | Create an empty mod folder and its line. | update-load-order-file |
| install | writes | `modbench.mod.install` | a file, a folder or a downloaded file | name, for a new mod; target mod, for an upgrade; choices, for a FOMOD ([mods-fomod.md](mods-fomod.md)); force: [agent.md](agent.md#any-agent), story 7 | MO2 mod list; MO2 Downloads | Install it as a new mod, or over an installed mod as an upgrade. | install-mod |
| decompile and commit | writes | `modbench.mod.decompileAndCommit` | mods | - | none | Put a mod under git: a repository in the source folder holding its plugin source, every other file of the mod as its assets, and a manifest naming this folder as the output, in one commit. On a plugin row or an Editor column, it acts on the plugin's mod. | decompile-and-commit |
| build | writes | `modbench.mod.build` | mods | - | none | Write a source mod's folder from its repository and the installation files its manifest names, as its manifest says: copy its assets, compile its plugins, run its steps, pack loose files into archives where its manifest says, and write its manifest's file lines. A file it did not make stays. On a plugin row or an Editor column, it acts on the plugin's mod. | build-mod |
| update manifest | writes | `modbench.mod.updateManifest` | mods or separators, or none for every mod | - | none | Write each mod's manifest from the mod and its metadata: where each file comes from, or that nothing does, and the mod's version. A source mod's manifest is left to its author and its build. | update-manifest |
| restore from manifest | writes | `modbench.mod.restoreFromManifest` | mods or separators, or none for every mod | force: [agent.md](agent.md#any-agent), story 7 | none | Make each mod's folder what its manifest says: write every file whose bytes differ, from the downloaded files it names, or by building its submodule at the commit the modlist pins, cloned when absent, write the mod's metadata, and send every other file the manifest does not name to the trash. An installation file the downloads folder lacks is first downloaded from Nexus. | restore-from-manifest |
| check for updates | writes | `modbench.mod.checkForUpdates` | mods or separators, or none for every mod | - | MO2 mod list | Ask Nexus for the newest version of each mod, and write it in the mod's metadata, as MO2 does. | - |
| sort direction | reads | `modbench.mod.sortWinningAtTop`, `modbench.mod.sortLosingAtTop` | - | - | MO2 mod list | List mods with the winning end at the top or at the bottom. | none |
| open folder | reads | `modbench.mod.openFolder` | mod, or overwrite, or a file or folder in one | - | MO2 mod list, Overwrite row | Show a mod's folder, or a file or folder in it, in VS Code's Explorer. The Overwrite row opens the overwrite folder. | none |
| open source | reads | `modbench.mod.openSource` | mod | - | none | Show a source mod's source folder in VS Code's Explorer. | none |
| view on Nexus | reads | `modbench.mod.viewOnNexus` | mod, or downloaded file | - | MO2 mod list; MO2 Downloads | Open the mod's Nexus page. The address comes from the mod's metadata, or from the downloaded file's. | none |
| open conflicts | reads | `modbench.mod.openConflicts` | mod | - | MO2 Information dialog, Conflicts tab | Open a mod's conflict table in an editor tab. | open-conflicts |
| compare file | reads | `modbench.mod.compareFile` | a copy of a file in a mod or Overwrite | - | none | Open VS Code's diff editor on a mod's copy of a file and the winning copy. | none |
| go to mod | reads | `modbench.mod.goToMod` | a copy of a file in a mod or Overwrite | other mod: a pick, when the copy wins over several | MO2 Information dialog, Conflicts tab, Go to... | Select, in Mods, the mod or Overwrite whose copy wins the file, or a mod whose copy it wins over. | none |
| exclude / include file | writes | `modbench.mod.excludeFile`, `modbench.mod.includeFile` | files in mods or Overwrite | - | MO2 Information dialog, Conflicts tab, Hide; MO2 mod list, Restore hidden files | Keep each file from the game with the mod manager's exclusion mark, as MO2's `.mohidden` suffix, or clear the mark, and, in a source mod, the manifest's exclusion with it. | update-load-order-file |
| rename | writes | `modbench.mod.rename` | mod | name | MO2 mod list | Rename a mod's folder and its name in every profile's mod order, and, for a source mod, its output folder in its manifest. Its publisher tags follow it. | update-load-order-file |
| add / remove publisher tag | writes | `modbench.mod.addPublisherTag`, `modbench.mod.removePublisherTag` | mods, or files and folders in mods | publisher tag: a pick | none | Add a publisher tag to each mod, folder or file, or remove it ([publishing.md](publishing.md), Publisher tags). | change-publisher-tag |

## Separator

A separator is a row in mod order.

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| add | writes | `modbench.separator.add` | mod or separator (the anchor) | name; position: above a mod, and the mod joins the new separator; below a separator, after its mods | MO2 mod list | Add a mod separator next to a mod or a separator. | update-load-order-file |
| rename | writes | `modbench.separator.rename` | separator | name | MO2 mod list | Rename a mod separator. | update-load-order-file |
| delete | writes | `modbench.separator.delete` | separators | - | MO2 mod list | Delete a mod separator. The mods under it join the separator above, or become ungrouped when it was the first. | update-load-order-file |

## Plugin

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| enable / disable | writes | `modbench.plugin.enable`, `modbench.plugin.disable` | plugins | - | MO2 plugin list | Flip each plugin's line in `plugins.txt`. Enable all is select all, then this gesture. | update-load-order-file |
| move | writes | `modbench.plugin.move` | plugins | target: the row it is dropped on, or the view's end. Several plugins move as one block | MO2 plugin list | Move plugins in plugin order. Masters stay above their dependants, and blueprint plugins stay last. | update-load-order-file |
| create | writes | `modbench.plugin.create` | - | name; place: Overwrite or an enabled mod | xEdit navigator | Create an empty plugin in Overwrite or in a mod. | create-plugin |
| decompile | writes | `modbench.plugin.decompile` | plugins | force: [agent.md](agent.md#any-agent), story 7 | none | Read each plugin's bytes into its plugin source, in the working tree of the checked-out branch. It commits nothing. | decompile-plugin |
| decompile and repair | writes | `modbench.plugin.decompileAndRepair` | plugins | force: [agent.md](agent.md#any-agent), story 7 | none | Decompile each malformed plugin and repair it: preview each change, then write two commits to its mod's plugin source, the first with the malformed records flagged, the second with the repairs. Refused when the plugin's bytes changed since the preview. The first commit does not compile: it is the one exception to A gesture writes nothing that compile refuses, as ADR-0007 allows history to hold non-building states. | - |
| sort direction | reads | `modbench.plugin.sortWinningAtTop`, `modbench.plugin.sortLosingAtTop` | - | - | MO2 plugin list | List plugins with the winning end at the top or at the bottom. | none |
| reveal | reads | `modbench.plugin.reveal` | plugin | - | MO2 plugin list | Show a plugin file in the system's file manager. | none |
| rename | writes | `modbench.plugin.rename` | plugin | name | none | Rename a compiled plugin: its file, its plugin source and its line in every profile's `plugins.txt`. | rename-plugin |

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
| open | reads | `modbench.record.open` | records, or a reference field | pinned | xEdit navigator; xEdit Referenced By; xEdit Compare Selected; xEdit Ctrl + click | Open a record in an editor tab. Several records open one grid: the first record's file, with the others as its columns. A plugin header is a record. The Go to Record menu item on a reference field opens the record it points to. With no Argument, a picker finds a record by EditorID, FormID or FormKey. | query-record-index |
| referenced by | reads | `modbench.record.referencedBy` | a record | - | xEdit Referenced By | List the records that reference a record, in VS Code's References view. With no Argument, the record tab in focus, or a picker. | query-record-index |
| open field value | reads | `modbench.record.openFieldValue` | record, plugin, field path | - | xEdit View grid | Open a field value in an editor tab. | none |
| filter | reads | `modbench.record.filter`, `modbench.record.clearFilter` | - | query: a `.sql` file, or a new document | xEdit navigator | Narrow the record tree to the FormKeys a SQL query returns. | query-record-index |
| collapse no conflict | reads | `modbench.record.collapseNoConflict`, `modbench.record.showNoConflict` | - | - | xEdit View grid, Hide no conflict and empty rows | Collapse the rows where every copy agrees and the columns identical to the master, in every record panel, or show them again. | none |

## Downloaded file

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| exclude / include | writes | `modbench.downloadedFile.exclude`, `modbench.downloadedFile.include` | downloaded files | - | MO2 Downloads | Mark downloaded files excluded in the metadata the mod manager keeps for them, as MO2's `.meta`, or clear the mark. `show excluded` decides whether the list shows them. | update-load-order-file |
| delete | writes | `modbench.downloadedFile.delete` | downloaded files | - | MO2 Downloads | Delete downloaded files. | update-load-order-file |
| query info | writes | `modbench.downloadedFile.queryInfo` | downloaded files | - | MO2 Downloads, Query Info (MD5) | Look each file up on Nexus, and write what Nexus knows of it in its metadata, as MO2 does. | - |
| open | reads | `modbench.downloadedFile.open` | downloaded file | - | MO2 Downloads | Open a downloaded file in its system application. | none |
| open metadata | reads | `modbench.downloadedFile.openMeta` | downloaded file | - | MO2 Downloads | Open the file that holds a downloaded file's metadata, as MO2's `.meta`, in an editor tab. | none |
| sort | reads | `modbench.downloadedFile.sort` | - | field | MO2 Downloads | Choose the field the downloaded files sort by. | none |
| show excluded | reads | `modbench.downloadedFile.showExcluded`, `modbench.downloadedFile.hideExcluded` | - | - | MO2 Downloads | Show or hide the excluded downloaded files. | none |

## System commands

Commands Modbench runs itself. No user starts them and no surface owns them, so they have no gesture and sit outside the object tables. The first column is the trigger that fires each one. Each is a command for the same reason a gesture is: one handler, and one identity. Each is internal: registered under its Command ID, with no entry point and no palette entry. A system command keeps the disk and mEdit in line with the instance. Put load order takes the snapshot as its Argument, because it hands mEdit the instance value as state ([ADR-0013](../adr/0013-mod-management-hands-editing-the-load-order.md)). A sync takes none, and reads the files it corrects through the Instance adapter ([ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md)).

| Trigger | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| The Instance loader recomputed the instance value ([load-instance](../../docs/traces/load-instance.d2)) | writes | `modbench.instance.putLoadOrder` | snapshot: the game release, every plugin in the instance and what provides it, the active plugins in load order, every mod with its folder and its metadata, and the stat cache's folder | - | none | Hand mEdit the whole snapshot at every recompute. | index-load-order; mod-status |
| The active profile's mod order disagrees with `mods/`: a folder with no line, or a line whose folder is gone | writes | `modbench.mod.sync` | - | - | MO2 refresh | Bring the active profile's mod order into line with `mods/`: add a line for each folder that has none, and drop each line whose folder is gone. One write. | update-load-order-file |
| The active profile's `plugins.txt` disagrees with the plugins provided, a plugin file where the game can load it from: an enabled mod, Overwrite or the game folder, or a plugin an enabled mod's manifest names: a plugin with no line, or a line that nothing provides | writes | `modbench.plugin.sync` | - | - | MO2 refresh | Bring `plugins.txt` into line with the plugins provided: add a line at the winning end, disabled, for each plugin that has none, and drop each line that nothing provides. One write. | update-load-order-file |