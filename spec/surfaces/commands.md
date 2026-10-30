# Commands

This file owns the UX vocabulary and the catalog of gestures. `GLOSSARY.md` owns the domain vocabulary. A gesture the code has and this file lacks is a defect in the code. A gesture this file has and the model cannot hold is a ticket.

- Object: a domain noun the user acts on. Each has its table below.
- Surface: what the user sees and acts in. It is a Modbench view, or a part of VS Code that Modbench extends, such as the text editor, Source Control or the terminal. A surface shows objects and offers their gestures.
- Gesture: one thing the user does to an object. One row in the tables below, under the object it acts on. The Gesture column holds the gesture's verb.
- Exclude and hide: to exclude is to mark an object durably on disk. The mark leaves the object out of something until include clears it, as the Downloads list leaves out an excluded downloaded file. To hide acts on the view alone. It changes nothing on disk and ends with the window, like hide excluded or a name filter.
- System command: a command Modbench runs itself, so it has no gesture ([System commands](#system-commands)).
- Where: each surface's Menus and keys lists the gestures it offers, where each sits and on what condition.
- Effect: `writes` when the gesture ends in a Core command that writes a file, a repository, a folder or a secret. `reads` when it only changes what the surface shows, or opens something. `runs` when it starts another program and writes nothing itself. `edits` when the gesture changes plugin source as a VS Code workspace edit and writes nothing itself. Saving the documents writes their files ([ADR-0001](../adr/0001-modbench-is-a-vscode-extension.md)).
- Command ID: the gesture's identity (One identity). It is `modbench.<object>.<verb>`, in camelCase, and the object owns it (`modbench.mod.enable`, `modbench.downloadedFile.delete`). A gesture every list view does to whatever it shows is `modbench.<verb>`, in Every view.
- Options: the inputs a gesture needs besides its Argument, such as a mode, a destination or a position. An Option may be computed and multi-valued, such as a checked list with defaults.
- Argument: the value that identifies the object or objects to the gesture, such as a plugin as `(origin, filename)`, or a FormKey. For a gesture that creates an object, it identifies the container. It is the same on every surface that offers the gesture. Singular means the clicked row, and plural means the whole selection.
- Template: the source, xEdit ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md)), MO2 ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)), LOOT ([ADR-0026](../adr/0026-modbench-checks-the-plugin-order-against-loots-metadata-and-never-sorts-it.md)) or git gesture this row follows, read from [the xEdit audit](../../docs/research/xedit-surface-audit.md), [the xEdit grid audit](../../docs/research/xedit-ux-audit.md), [the MO2 audit](../../docs/research/mo2-surface-audit.md), [the LOOT research](../../docs/research/loot-integration.md). `none` means the template has no such gesture: the row is an addition or a divergence, and needs a ruling.
- Trace: the sequence diagram of the gesture's flow. `-` means the trace is still to draw, and drawing it is part of designing the gesture. `none` means the gesture has no flow between boxes: its specification is this row and its surface.
- Meaning: what the gesture does, in one sentence. Its surface holds the stories.
- Ruled out: a gesture the maintainer has cut is not in any table. See [Ruling a gesture out](#ruling-a-gesture-out).

A toggle or an opposite pair (enable and disable, move up and move down) is one row with both directions, and both Command IDs. Any other gesture has one Command ID. A gesture that appears on several surfaces has one row, and each surface adapts its own item to the Argument.

## Principles

- Progressive disclosure. A surface shows the common gesture first and asks for the rest when it is needed. A gesture with variants is one gesture with Options. It is not a flat list of near-duplicate menu items.
- The entry point supplies what it knows. A menu on an object passes the object. A palette entry or a keybinding has no clicked row, so the gesture takes the focused view's selection. A gesture never guesses: it asks for what its caller left out, the Argument included, and a picker asks the user. Any caller may supply everything.
- When to group. Variants are one gesture when all four of these hold:
  1. The user names them with the same verb and a qualifier: "copy as", "move to".
  2. The Argument has the same shape.
  3. The variants differ along one dimension the user chooses: a mode, a target or a placement.
  4. The result is the same kind of thing.

  A category word such as "edit" fails the first test, so its variants are separate gestures.
- A gesture is atomic. It does one thing the user intends, however many steps it takes inside. A chain of gestures is a script the user writes (Minimal by default).
- An all variant is select all, then the gesture. A gesture over a selection needs no second gesture for everything.
- Entry points are not gestures. Every gesture is a command. The palette lists it, and the user can bind a key to it. A menu item, a default key or a mouse click is an entry point to the same command, not a second gesture. Where VS Code gives an entry point no way to pass an Option or name its view, the entry point is an internal command that fires the gesture with them. It is not a gesture: the catalog does not list it, and it has no palette entry.
- A task is an entry point for a chain. A gesture the user chains, such as build, then deploy, then the game, is also a VS Code task that Modbench provides. Its surface says so. The user's `tasks.json` holds the chain and the default build task. Modbench never writes it. A task takes no selection: its definition supplies the Argument, or none. It ends when its gesture ends, and writes the outcome in its terminal. It succeeds only when every item lands as asked, so a chain never runs on less: the gesture's surface names each warning that the output differs from the request. A failed task stops the chain.
- An entry point fires one gesture and chains no other: a chain is the user's (A gesture is atomic). It may fire any gesture, passing the Argument, as a click on a plugin row opens its header. A gesture does not fire another. A gesture that acts on another box's outcome calls that box through a project reference.
- One identity. The Command ID is the identity of a gesture, and keeps the Gesture column's verb. A title or a label is the code's to word: it says truly what the gesture does to what it receives, short. A word borrowed from a tool keeps the meaning it has there: a gesture takes git's word only when it runs that git operation. A verb that needs more than a few words means the concept lacks a term, and the maintainer names it.
- No dead entries. A gesture that is not available, or not applicable, is not shown. A gesture that is offered and then cannot proceed still refuses, and says why (see the next principle).
- Refuse, do not repair. A gesture that cannot proceed says why, and changes nothing to get past the cause. The user fixes the cause, or runs a gesture that fixes it.
- A gesture leaves nothing that compile refuses. Compile is the one bar on plugin source, and what a gesture leaves meets it.
- A failed gesture leaves nothing the user cannot make whole. A command that cannot finish reports what it left unfinished ([ADR-0019](../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md)).
- A selection is one gesture, and each item lands on its own. A gesture over several objects is one command with the whole selection as its Argument, asked once. An item that cannot proceed writes nothing and is refused, naming why; the others land. The result names both ([ADR-0019](../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md)). A cause that no item can escape, such as git missing from the PATH, refuses the whole selection once, before any item is written.
- Esc changes nothing. Cancelling a pick or a prompt ends the gesture with no write and no message.
- Confirm what destroys. A gesture asks first, once for the whole selection, when the user cannot take it back in one step. The confirmation names what it would lose. A confirmation for anything less stands between the user and the work (Minimal by default).
- Design for the agent. The agent runs a gesture through a request ([agent.md](agent.md)), so a new gesture's design answers four questions, where its agent.md stories do not already answer them: does the agent run it; what does the agent read before it runs it, as a view shows the user; how does the agent supply what each picker, prompt and confirmation asks; and does the gesture need a force Option, because it confirms what it destroys.
- A gesture that writes ends when the read model shows it. It writes its file and keeps no copy of the new state. The view then asks for a read, and the gesture ends when the read model shows the change. The read model's value always wins. It reads an unsaved document in place of its file, so a file's own editor and every other view show one value ([ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md); [ADR-0001](../adr/0001-modbench-is-a-vscode-extension.md)).
- A gesture on plugin source edits its documents: VS Code applies the changes as one workspace edit, as it does a refactoring ([ADR-0001](../adr/0001-modbench-is-a-vscode-extension.md)).
- A compiled plugin is its files. A gesture on its records reads and writes its plugin source, so it works whether the plugin is active or not. Only a judgement against other plugins needs the load order. A plugin that is not active is judged at its line in `plugins.txt`. With no line, no judgement applies, and the gesture lands ([ADR-0006](../adr/0006-a-compiled-plugins-truth-is-its-plugin-source.md)).
- Doing nothing is not an error. A gesture whose result equals the current state writes nothing and says nothing.
- No lifecycle gestures for mEdit. The backend starts with the extension. No gesture starts, stops or reloads it.
- One filter. Every list has the same name filter (common.md, The name filter).

## Chrome

Rules for the title bar of a view.

- A view shows at most four icons of its own, and a filter and its clear count as one. Collapse All is VS Code's.
- An icon is earned. A state readout or a common toggle keeps one. A configure-once gesture goes in the overflow.
- A destructive gesture never gets an icon. It sits in the overflow.
- The order is the name filter, the view's state toggle, domain gestures, the overflow, and Collapse All last. Collapse All is on trees only.
- An action that is not about a tree's own object goes on the Toolbox, the status bar or the palette.

## Ruling a gesture out

A template is a standalone program. Modbench is not. A gesture leaves this file only for a reason in the summary table of [xedit.md](../out-of-scope/xedit.md) or [mo2.md](../out-of-scope/mo2.md), or the omissions of [loot.md](../out-of-scope/loot.md), and that file lists it. A new reason joins the summary table first.

## Surfaces and their templates

| Surface | xEdit template | MO2 template | What it shows |
|---|---|---|---|
| Toolbox | main menu | toolbar, profile combo | [toolbox.md](toolbox.md) |
| Mods | - | mod list | [mods.md](mods.md) |
| Plugins | navigator | plugin list | [plugins.md](plugins.md) |
| Downloads | - | Downloads tab | [downloads.md](downloads.md) |
| Editor | View grid, Referenced By | - | [editor.md](editor.md) |
| Plugin source | Referenced By, Ctrl + click | - | [plugin-source.md](plugin-source.md) |
| Agent | - | - | [agent.md](agent.md) |
| Scripts | Apply Script | - | [scripts.md](scripts.md) |
| Modlist repository | - | - | [modlist-repository.md](modlist-repository.md) |
| Deployment: hardlink | - | - | [deployment-hardlink.md](deployment-hardlink.md) |

The xEdit Messages tab is not a surface: failures and wrong states go where common.md, Reporting says.

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

Every view is always present. A view with nothing to show renders its own empty state, and no view hides itself.

## Every view

What every list view does to whatever it shows, whatever the object. common.md says how each behaves, and each surface says what its rows copy.

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| copy value | reads | `modbench.copyValue` | selection | - | MO2 mod list, plugin list and Downloads; xEdit navigator, Referenced By and View grid | Copy the selection to the clipboard as text. | none |
| filter | reads | `modbench.filter`, `modbench.clearFilter` | - | - | MO2 mod list, plugin list and Downloads; xEdit navigator and Referenced By | Narrow the focused list by name. | none |

## Instance

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| open settings | reads | `modbench.settings.open` | - | setting to show, when the caller names one | MO2 toolbar | Open VS Code's Settings editor, filtered to Modbench's settings. | none |
| log in / log out | writes | `modbench.instance.logIn`, `modbench.instance.logOut` | - | key | MO2 settings, Nexus tab, Enter API Key Manually | Keep my Nexus API key, or forget it. | none |
| refresh | writes | `modbench.instance.refresh` | - | - | MO2 toolbar | Rebuild the record index, and read the instance again from disk. | load-instance |
| deploy / purge | writes | `modbench.instance.deploy`, `modbench.instance.purge` | - | - | none | Deploy the active profile's load order to the deployment folder, or remove what deploy wrote there ([deployment-hardlink.md](deployment-hardlink.md)). | - |
| move to Overwrite | writes | `modbench.instance.moveToOverwrite` | files in the deployment folder that deploy does not manage | - | none | Move each file into Overwrite at its path, so the next deploy links it back. | - |
| update masterlist | writes | `modbench.instance.updateMasterlist` | - | force: [agent.md](agent.md#any-agent), story 7 | LOOT, Update Masterlist | Fetch the game's masterlist and prelude from LOOT into the instance, in the metadata version this Modbench reads. | update-masterlist |

## Profile

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| switch | writes | `modbench.profile.switch` | profile | - | MO2 profile combo | Change the active profile. | update-load-order-file |

## Modlist

The instance's mods and profiles as git holds them ([modlist-repository.md](modlist-repository.md)).

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| git init | writes | `modbench.modlist.gitInit` | - | - | git init | Make the instance a repository, or adopt the one it holds. | init-modlist |

## Mod

The Overwrite row is a mod-list row, not a mod; its `Argument` is `overwrite`.

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| enable / disable | writes | `modbench.mod.enable`, `modbench.mod.disable` | mods | - | MO2 mod list | Enable or disable each mod in the active profile. | update-load-order-file |
| move | writes | `modbench.mod.move` | mods or separators | target: a separator, above a mod, or the view's end | MO2 mod list | Move mods in mod order. | update-load-order-file |
| uninstall | writes | `modbench.mod.uninstall` | mods | force: [agent.md](agent.md#any-agent), story 7 | MO2 mod list | Send each mod's folder, and a source mod's source, to the trash, and remove the mod from mod order. | update-load-order-file |
| create empty mod | writes | `modbench.mod.createEmpty` | - | name | MO2 mod list | Create an empty mod folder and its line. | update-load-order-file |
| install | writes | `modbench.mod.install` | a file, a folder or a downloaded file | name, for a new mod; target mod, for an upgrade; choices, for a FOMOD ([mods-fomod.md](mods-fomod.md)); install anyway, for a FOMOD that names a missing file; force: [agent.md](agent.md#any-agent), story 7 | MO2 mod list; MO2 Downloads | Install it as a new mod, or over an installed mod as an upgrade. | install-mod |
| decompile and commit | writes | `modbench.mod.decompileAndCommit` | mods | - | none | Make a mod a source mod: a repository that holds its plugin source, in one commit. | decompile-and-commit |
| build | writes | `modbench.mod.build` | mods, or none for every source mod | force: [agent.md](agent.md#any-agent), story 7 | none | Write a source mod's folder as its build file says, and record it, with the mod's metadata, in its manifest. | build-mod |
| update manifest | writes | `modbench.mod.updateManifest` | mods or separators, or none for every manifest | - | none | Record each folder but a source mod's in its manifest, with the mod's metadata. | update-manifest |
| restore from manifest | writes | `modbench.mod.restoreFromManifest` | mods or separators, or none for every manifest | force: [agent.md](agent.md#any-agent), story 7 | none | Make each folder what its manifest says, building each source mod's. | restore-from-manifest |
| check for updates | writes | `modbench.mod.checkForUpdates` | mods or separators, or none for every mod | - | MO2 mod list | Ask Nexus for the newest version of each mod, and write it in the mod's metadata. | - |
| sort direction | reads | `modbench.mod.sortWinningAtTop`, `modbench.mod.sortLosingAtTop` | - | - | MO2 mod list | List mods with the winning end at the top or at the bottom. | none |
| open folder | reads | `modbench.mod.openFolder` | mod, or overwrite, or a file or folder in one | - | MO2 mod list, Overwrite row | Show a mod's folder, or a file or folder in it, in VS Code's Explorer. | none |
| open source | reads | `modbench.mod.openSource` | mod | - | none | Show a source mod's repository in VS Code's Explorer. | none |
| view on Nexus | reads | `modbench.mod.viewOnNexus` | mod, or downloaded file | - | MO2 mod list; MO2 Downloads | Open the mod's Nexus page. | none |
| open conflicts | reads | `modbench.mod.openConflicts` | mod | - | MO2 Information dialog, Conflicts tab | Open a mod's conflict table in an editor tab. | open-conflicts |
| compare file | reads | `modbench.mod.compareFile` | a copy of a file in a mod or Overwrite | - | none | Open VS Code's diff editor on a mod's copy of a file and the winning copy. | none |
| go to mod | reads | `modbench.mod.goToMod` | a copy of a file in a mod or Overwrite | other mod: a pick, when the copy wins over several | MO2 Information dialog, Conflicts tab, Go to... | Select, in Mods, the mod or Overwrite whose copy wins the file, or a mod whose copy it wins over. | none |
| exclude / include file | writes | `modbench.mod.excludeFile`, `modbench.mod.includeFile` | files in mods or Overwrite | - | MO2 Information dialog, Conflicts tab, Hide; MO2 mod list, Restore hidden files | Keep each file from the game with the mod manager's exclusion mark, or clear the mark. | update-load-order-file |
| rename | writes | `modbench.mod.rename` | mod | name | MO2 mod list | Rename a mod's folder, and the mod wherever a profile names it. | update-load-order-file |
| add / remove publisher tag | writes | `modbench.mod.addPublisherTag`, `modbench.mod.removePublisherTag` | mods, or files and folders in mods | publisher tag: a pick | none | Add a publisher tag to each mod, folder or file, or remove it ([publishing.md](publishing.md), Publisher tags). | change-publisher-tag |

## Separator

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| add | writes | `modbench.separator.add` | mod or separator (the anchor) | name; position: above a mod, and the mod joins the new separator; below a separator, after its mods | MO2 mod list | Add a mod separator. | update-load-order-file |
| rename | writes | `modbench.separator.rename` | separator | name | MO2 mod list | Rename a mod separator. | update-load-order-file |
| delete | writes | `modbench.separator.delete` | separators | force: [agent.md](agent.md#any-agent), story 7 | MO2 mod list | Delete a mod separator, and keep its mods. | update-load-order-file |

## Plugin

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| enable / disable | writes | `modbench.plugin.enable`, `modbench.plugin.disable` | plugins | - | MO2 plugin list | Enable or disable each plugin in the active profile. | update-load-order-file |
| move | writes | `modbench.plugin.move` | plugins | target: the row it is dropped on, or the view's end. Several plugins move as one block | MO2 plugin list | Move plugins in plugin order. | update-load-order-file |
| create | writes | `modbench.plugin.create` | Overwrite or an enabled mod | name | xEdit navigator | Create an empty plugin. | create-plugin |
| decompile | writes | `modbench.plugin.decompile` | plugins | force: [agent.md](agent.md#any-agent), story 7 | none | Read each plugin's bytes into its plugin source in the working tree. | decompile-plugin |
| decompile and repair | writes | `modbench.plugin.decompileAndRepair` | plugins | force: [agent.md](agent.md#any-agent), story 7 | none | Decompile each malformed plugin and repair it, in two commits to its mod's plugin source. | - |
| sort direction | reads | `modbench.plugin.sortWinningAtTop`, `modbench.plugin.sortLosingAtTop` | - | - | MO2 plugin list | List plugins with the winning end at the top or at the bottom. | none |
| reveal | reads | `modbench.plugin.reveal` | plugin | - | MO2 plugin list | Show a plugin file in the system's file manager. | none |
| rename | writes | `modbench.plugin.rename` | plugin | name | none | Rename a compiled plugin, the files named for it, and its lines. | rename-plugin |
| apply suggested move | writes | `modbench.plugin.applySuggestedMove` | plugin | broken sorting rule: a pick, when more than one offers a move | none | Move a plugin to the nearest place that keeps a broken sorting rule. | update-load-order-file |
| load after | writes | `modbench.plugin.loadAfter` | plugins | plugins to load after: a pick | LOOT, Edit Metadata, Load After | Add a sorting rule to the userlist that each plugin loads after the picked plugins. | update-load-order-file |

## Record

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| edit field | edits | `modbench.record.editField` | record, plugin, field path | value: set, or paste by keys or by drag and drop | xEdit View grid; xEdit drag between columns | Change a field's value in plugin source. | edit-record |
| add element | edits | `modbench.record.addElement` | array | value (a paste by keys or by drag and drop supplies it; otherwise a new element) | xEdit View grid | Add an element to an array field. | edit-record |
| remove element | edits | `modbench.record.removeElement` | element | - | xEdit View grid | Remove an element from an array field. | edit-record |
| cut | edits | `modbench.record.cut` | record, plugin, field path | - | none | Copy a field's value, or an element, and remove it, in one edit. | edit-record |
| move element | edits | `modbench.record.moveElementUp`, `modbench.record.moveElementDown` | element | - | xEdit View grid | Move an element one step in an array field. | edit-record |
| create | edits | `modbench.record.create` | plugin, or a container record | record type; grid position, for an exterior cell | xEdit navigator | Add a record to a plugin, or a child record to a record. | edit-record |
| delete | edits | `modbench.record.delete` | records | - | xEdit navigator, Referenced By, View header | Remove records from a plugin. | edit-record |
| copy | edits | `modbench.record.copy` | records | mode: new or override; destination plugins; replace, for a destination that holds the record | xEdit navigator, Referenced By, View header; xEdit Inject Forms into master... | Copy records into other plugins. | edit-record |
| open | reads | `modbench.record.open` | records, a reference field, or a templated field | pinned | xEdit navigator; xEdit Referenced By; xEdit Compare Selected; xEdit Ctrl + click | Open a record in an editor tab. | query-record-index |
| referenced by | reads | `modbench.record.referencedBy` | a record | - | xEdit Referenced By | List the records that reference a record, in VS Code's References view. | query-record-index |
| open field value | reads | `modbench.record.openFieldValue` | record, plugin, field path | - | xEdit View grid | Open a field value in an editor tab. | none |
| filter | reads | `modbench.record.filter`, `modbench.record.clearFilter` | - | query: a `.sql` file, or a new document | xEdit navigator | Narrow the record tree to the FormKeys a SQL query returns. | query-record-index |
| collapse no conflict | reads | `modbench.record.collapseNoConflict`, `modbench.record.showNoConflict` | - | - | xEdit View grid, Hide no conflict and empty rows | Collapse the rows and columns that add nothing to the conflict, in every record panel, or show them again. | none |

## Downloaded file

| Gesture | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| exclude / include | writes | `modbench.downloadedFile.exclude`, `modbench.downloadedFile.include` | downloaded files | - | MO2 Downloads | Mark downloaded files excluded in the metadata the mod manager keeps for them, or clear the mark. | update-load-order-file |
| delete | writes | `modbench.downloadedFile.delete` | downloaded files | - | MO2 Downloads | Send downloaded files to the trash. | update-load-order-file |
| query info | writes | `modbench.downloadedFile.queryInfo` | downloaded files | - | MO2 Downloads, Query Info (MD5) | Look each file up on Nexus, and write what Nexus knows of it in its metadata. | - |
| open | reads | `modbench.downloadedFile.open` | downloaded file | - | MO2 Downloads | Open a downloaded file in its system application. | none |
| open metadata | reads | `modbench.downloadedFile.openMeta` | downloaded file | - | MO2 Downloads | Open the file that holds a downloaded file's metadata in an editor tab. | none |
| sort | reads | `modbench.downloadedFile.sort` | - | field; direction | MO2 Downloads | Choose the field the downloaded files sort by. | none |
| show excluded | reads | `modbench.downloadedFile.showExcluded`, `modbench.downloadedFile.hideExcluded` | - | - | MO2 Downloads | Show or hide the excluded downloaded files. | none |

## System commands

Commands Modbench runs itself. No user starts them, so they have no gesture. The first column is the trigger that fires each one. Each is a command for the same reason a gesture is: one handler, and one identity. Each is internal: registered under its Command ID, with no entry point and no palette entry. A system command keeps the disk and mEdit in line with the instance. Put load order takes the snapshot as its Argument, because it hands mEdit the instance value as state ([ADR-0013](../adr/0013-mod-management-hands-editing-the-load-order.md)). A sync takes none, and reads the files it corrects through the Instance adapter ([ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md)).

| Trigger | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| The Instance loader recomputed the instance value ([load-instance](../../docs/traces/load-instance.d2)) | writes | `modbench.instance.putLoadOrder` | snapshot: the instance value mEdit edits against ([ADR-0013](../adr/0013-mod-management-hands-editing-the-load-order.md)) | - | none | Hand mEdit the whole snapshot at every recompute. | index-load-order |
| The active profile's mod order disagrees with the mods, each what its manifest says where it has one ([ADR-0022](../adr/0022-git-versions-how-each-folder-is-made-not-the-folder.md)) | writes | `modbench.mod.sync` | - | - | MO2 refresh | Add a line for each mod that has none, and drop each line whose mod is gone. | update-load-order-file |
| The active profile's `plugins.txt` disagrees with the plugins provided: each plugin the game can load, and each an enabled mod's manifest names | writes | `modbench.plugin.sync` | - | - | MO2 refresh | Add a line at the winning end, disabled, for each plugin that has none, and drop each line that nothing provides. | update-load-order-file |