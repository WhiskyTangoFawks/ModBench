# Commands

This file owns the UX vocabulary and the catalog of gestures. `CONTEXT.md` owns the domain
vocabulary. A gesture or command the code has and this file lacks is a defect in the code.
A gesture this file has and the model cannot hold is a ticket.

- **Object**: a domain noun the user acts on: Instance, Profile, Mod, Separator, Plugin, Record,
  Referrer, Downloaded file. `CONTEXT.md` defines each one. Settings is Modbench's own
  configuration, which VS Code stores at user and workspace scope. It is the object of
  `open settings` only, and `CONTEXT.md` does not define it, because it is not a domain noun.
- **Surface**: what a driving box presents to the user. One surface per driving box on the
  Modbench side. A surface shows objects and offers their gestures. A VS Code view or an editor
  realizes it.
- **Gesture**: one thing the user does to an object. One row in the tables below, under the
  object it changes. The Gesture column holds the verb the user sees, in a menu or a label.
- **Exclude and hide**: to exclude is to mark an object durably on disk, so it is left out of
  something until include clears the mark, as a downloaded file is left out of its list. To hide is a view's own lens: it changes nothing on disk and ends with the window,
  like hide excluded or a name filter.
- **System command**: a command Modbench runs itself. No user starts it and no surface owns it, so it
  has no gesture. Its first column is the trigger that fires it. It has its own section, after the
  objects.
- **Where**: the entry points of the gesture, surface by surface, as `<surface>: <entry point>`
  with a condition in brackets, separated by semicolons. It states the model, not the code. The
  entry points are `context menu`, `title icon`, `title overflow`, `inline button`, `row click`, `key`
  (a default chord goes in brackets), `drag`, `check box`, `webview message`, `dialog answer`, `code
  action`, `code lens` and `automatic`. A gesture is absent, not refused, where its condition is false. Every
  gesture is also in the command palette, unless it is marked internal. An **internal** command is
  registered under its Command ID and has no entry point and no palette entry.
- **Effect**: `writes` when the gesture ends in a Core command that writes a file, a repository
  or a folder. `reads` when it only changes what the surface shows, or opens something. `runs`
  when it starts another program and writes nothing itself.
- **Command ID**: the registered interface and the source of truth, which the code reflects. It is
  `modbench.<object>.<verb>`, in camelCase, and the object owns it (`modbench.mod.enable`,
  `modbench.downloadedFile.delete`). `-` means the gesture has none. A toggle or opposite pair has one
  ID per direction. A gesture every list view does to whatever it shows is `modbench.<verb>`, in
  Every view.
- **Options**: the inputs a gesture needs besides its Argument, such as a mode, a destination or a
  position. A picker asks for each Option the caller did not supply. An Option may be computed
  and multi-valued, such as a checked list with defaults.
- **Argument**: the value that identifies the object or objects to the gesture, such as a plugin,
  as origin and file name, or a FormKey. For a gesture that creates an object, it identifies the container, when the
  entry point is on the container's row. A create from a title icon has none, and its container is
  an Option. It is the same on every surface that offers the gesture. Singular means the clicked
  row, and plural means the whole selection.
- **Template**: the source, xEdit ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md))
  or MO2 ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)) gesture this row
  follows, read from [the xEdit audit](../research/xedit-surface-audit.md),
  [the xEdit grid audit](../research/xedit-ux-audit.md) and
  [the MO2 audit](../research/mo2-surface-audit.md). `none` means the template has no such
  gesture: the row is an addition or a divergence, and needs a ruling.
- **Trace**: the sequence diagram of the gesture's flow. `-` means the trace is still to draw, and
  drawing it is part of designing the gesture. `none` means the gesture has no flow between boxes:
  its specification is this row and its surface. Gestures whose arrows are the same share one
  diagram. Beside each diagram, a `.md` file of the same name holds the contract: what the flow
  promises, step by step, where it hands off, what it refuses, and what a failure leaves.
- **Ruled out**: a gesture the maintainer has cut is not in any table. See
  [Ruling a gesture out](#ruling-a-gesture-out).

A toggle or an opposite pair (enable and disable, move up and move down) is one row with both
directions, and both Command IDs. Any other gesture has one Command ID. A gesture that appears on several surfaces has one row, and each surface adapts its
own item to the Argument.

## Principles

- **Progressive disclosure.** A surface shows the common gesture first and asks for the rest when
  it is needed. A gesture with variants is one gesture with Options. It is not a flat list of
  near-duplicate menu items.
- **The surface supplies the Argument. A picker supplies the Options.** A menu on an object passes
  the object. The gesture asks only for the Options the caller left out. A keybinding, a webview
  message or an agent call may supply all of them.
- **One command per gesture.** A toggle or an opposite pair registers one for each direction.
- **When to group.** Variants are one gesture when all four of these hold:
  1. The user names them with the same verb and a qualifier: "copy as", "move to", "open beside".
  2. The Argument has the same shape.
  3. The variants differ along one dimension the user chooses: a mode, a target or a placement.
  4. The result is the same kind of thing.

  A category word such as "edit" fails the first test, so its variants are separate gestures. An
  opposite pair is one row with two entries, and it needs no picker. Gestures that share a flow share
  a diagram; that does not merge them.
- **A gesture is atomic.** It does one thing the user intends, however many steps it takes inside. A
  chain of gestures the user already has, such as installing and then moving, is a script the user
  writes.
- **An *all* variant is select all, then the gesture.** A gesture over a selection needs no
  second gesture for everything.
- **Entry points are not gestures.** Every gesture is a command. The palette lists it, and the user
  can bind a key to it. A menu item, a default key or a mouse click is an entry point to the same
  command, not a second gesture.
- **An entry point fires a gesture. A gesture does not fire another.** An entry point on any
  surface may fire any gesture through the command registry. It passes the Argument and uses no
  result, as a click on a plugin row opens its header. A gesture that needs another box's work as
  a step, and acts on its outcome, calls that box through a reference the reference view draws.
- **One identity.** The Command ID is the identity of a gesture. The Gesture column is the verb
  the user sees for it, and the palette title is that verb plus the object ("Modbench: Rename Mod"),
  or the verb alone for a gesture in Every view ("Modbench: Copy Value").
  Keep the ID's verb and the user's verb the same words. Prefer existing software-development
  language, and keep both short. A verb that needs more than three words means the concept lacks a
  term, so define the term first.
- **No dead entries.** A gesture that is not available, or not applicable, is not shown. It is never
  shown and then refused for that reason. A gesture that is offered and then cannot proceed still
  refuses, and says why (see the next principle).
- **Refuse, do not repair.** When a gesture cannot proceed, it says why and stops. The user fixes
  the cause and tries again.
- **A gone object is refused.** A gesture whose object has gone from disk is refused, and the refusal
  names it.
- **A failed gesture writes nothing.** When a command cannot finish, it leaves the files as they
  were and reports the failure
  ([ADR-0019](../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md)). A
  contract names any gesture that cannot promise this.
- **A selection is one gesture, and each item lands on its own.** A gesture over several objects is
  one command with the whole selection as its Argument, asked once. An item that cannot proceed
  writes nothing and is refused, naming why; the others land. The result names both
  ([ADR-0019](../adr/0019-failures-are-data-the-front-end-decides-how-to-surface-them.md),
  invariant 4). A cause that no item can escape, such as git missing from the PATH or mEdit not
  answering, refuses the whole selection once, before any item is written.
- **Esc changes nothing.** Cancelling a pick or a prompt ends the gesture with no write and no
  message.
- **Confirm what destroys.** A gesture that deletes an object, or replaces a whole object, asks
  first. It asks once for the whole selection. An edit to a value inside a record changes the record
  and deletes nothing, so it does not ask. No other gesture asks. A surface or a contract can name
  an exception, with its reason.
- **A write is forgotten.** A gesture writes its file and keeps no copy of the new state. The watch
  reads the file back, and every view updates from the disk's next value. Until then, the thing the
  gesture changed shows its result, marked unconfirmed, and nothing else in the view changes
  (common.md, Unconfirmed writes). The disk's value always wins.
- **Doing nothing is not an error.** A gesture whose result equals the current state writes nothing
  and says nothing.
- **No lifecycle gestures for mEdit.** The backend starts with the extension. No gesture starts,
  stops or reloads it.
- **One filter.** Every list has the same name filter. It stays until cleared, its term shows in the
  view description, and the same slot clears it.
- **Stay in the panel.** No click on the record panel moves the user out of it. A gesture that
  opens another tab is on the right-click menu.

## Chrome

Rules for the title bar of a view.

- A view shows at most four icons, and a filter and its clear count as one.
- An icon is earned. A state readout or a common toggle keeps one. A configure-once gesture goes in
  the overflow.
- A destructive gesture never gets an icon. It sits in the overflow, behind a confirmation.
- The order is the name filter, the view's state toggle, domain gestures, the overflow, and Collapse
  All last. Collapse All is on trees only.
- An action that is not about a tree's own object goes on the Toolbox, the status bar or the
  palette.
- The icons: search narrows by name, filter narrows by condition, clear-all clears a durable
  filter, and there is one refresh.

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

| Surface | xEdit template | MO2 template | What it shows |
|---|---|---|---|
| Toolbox | main menu | toolbar, run box, profile combo | [toolbox.md](surfaces/toolbox.md) |
| Mods | - | mod list | [mods.md](surfaces/mods.md) |
| Plugins | navigator | plugin list | [plugins.md](surfaces/plugins.md) |
| Downloads | - | Downloads tab | [downloads.md](surfaces/downloads.md) |
| Editor | View grid, Referenced By | - | [editor.md](surfaces/editor.md) |

The xEdit Messages tab is not a surface. Failures go to the Output and the surface their severity
calls for (ADR-0019); diagnostics go to the Problems panel.

## Where surfaces live

| Surface | Container | Order | Default |
|---|---|---|---|
| Toolbox | Activity Bar (`modbench`) | 1 | open |
| Mods | Activity Bar | 2 | open |
| Plugins | Activity Bar | 3 | open |
| Downloads | Activity Bar | 4 | collapsed |
| Editor, the record panel | an editor tab | - | opened by the user |
| Editor, Referenced By | Panel (`modbenchReferencedBy`) | - | follows the active record |

Every view is always present. A view with nothing to show renders its own empty state, and no
view hides itself. Referenced By is a Panel view because it follows the active record, and a
sidebar view cannot sit beside an editor tab.

## Every view

What every list view does to whatever it shows, whatever the object. common.md says how each
behaves, and each surface says what its rows copy. The Toolbox is a readout, not a list, and offers
neither.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|---|
| copy value | reads | Mods, Plugins, Downloads: context menu, key; Editor: context menu, key | `modbench.copyValue` | selection | - | MO2 mod list, plugin list and Downloads; xEdit navigator, Referenced By and View grid | Copy the selection to the clipboard as text, one item to a line, each as its surface says. | none |
| filter | reads | Mods, Plugins, Downloads: title icon; Editor: title icon (on Referenced By) | `modbench.filter`, `modbench.clearFilter` | - | - | MO2 mod list, plugin list and Downloads; xEdit navigator and Referenced By | Narrow the focused list by name. | none |

## Instance

Offered on Toolbox.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|---|
| open settings | reads | Toolbox: title overflow | `modbench.settings.open` | - | - | MO2 toolbar | Open VS Code's Settings editor, filtered to Modbench's settings. | none |
| refresh | writes | Toolbox: title icon | `modbench.instance.refresh` | - | - | MO2 toolbar | Drop and rebuild the index and re-read every source from disk. One gesture for all of Modbench. It is a safety net, not how changes normally arrive, and it clears every unconfirmed mark (common.md, Unconfirmed writes). It is refused while another window holds the index. | load-instance |

## Profile

Offered on Toolbox. A Profile is part of the Instance.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|---|
| switch | writes | Toolbox: row click, context menu, key (Enter) | `modbench.profile.switch` | profile | - | MO2 profile combo | Change the active MO2 profile. With no Argument, a picker lists the profiles. | update-load-order-file |

## Mod

Offered on Mods, and on Downloads for install. The Overwrite row is a mod-list row, not a mod; its `Argument` is `overwrite`.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|---|
| enable / disable | writes | Mods: check box, key, context menu | `modbench.mod.enable`, `modbench.mod.disable` | mods | - | MO2 mod list | Flip each mod's line in `modlist.txt`. Enable all is select all, then this gesture. | update-load-order-file |
| move | writes | Mods: drag, context menu | `modbench.mod.move` | mods or separators | target: a separator, above a mod, or the view's end | MO2 mod list | Move mods in mod order. | update-load-order-file |
| uninstall | writes | Mods: context menu, key (Delete) | `modbench.mod.uninstall` | mods | - | MO2 mod list | Move a mod folder to the trash and remove its line. | update-load-order-file |
| create empty mod | writes | Mods: context menu, title overflow | `modbench.mod.createEmpty` | - | name | MO2 mod list | Create an empty mod folder and its line. | update-load-order-file |
| install | writes | Mods: context menu, title overflow; Downloads: context menu | `modbench.mod.install` | source: archive, folder or downloaded file | target mod, for an upgrade | MO2 mod list; MO2 Downloads | Install a source as a new mod, or over a mod with the same Nexus id when the user confirms the target. That is an upgrade. A downloaded file supplies its own source; the Mods menu asks for one. | install-mod |
| track | writes | Mods: context menu (mod has no repository and holds a plugin); Plugins: context menu (plugin in a mod with no repository); Editor: context menu (column of a plugin in a mod with no repository) | `modbench.mod.track` | mods | preset: Edits or Everything | none | Put a mod under git. It fires `decompile plugin`, which creates the mod's repository and commits the mod's own files, then each plugin's baseline as its own commit. A plugin row or an Editor column fires it for the plugin's mod. | decompile-plugin |
| sort direction | reads | Mods: title icon | `modbench.mod.sortWinningAtTop`, `modbench.mod.sortLosingAtTop` | - | - | MO2 mod list | List mods with the winning end at the top or at the bottom. | none |
| open folder | reads | Mods: context menu | `modbench.mod.openFolder` | mod, or overwrite | - | MO2 mod list, Overwrite row | Show a mod's files in VS Code's Explorer, decorated by conflict status. The Overwrite row opens the overwrite folder. | none |
| view on Nexus | reads | Mods: context menu (mod has a Nexus id); Downloads: context menu (file has a Nexus id) | `modbench.mod.viewOnNexus` | mod, or downloaded file | - | MO2 mod list; MO2 Downloads | Open the mod's Nexus page. The address comes from the mod's `meta.ini`, or from the downloaded file's `.meta`. | none |

## Separator

Offered on Mods. A separator is a row in mod order.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|---|
| add | writes | Mods: context menu | `modbench.separator.add` | mod or separator (the anchor) | position: above a mod, which joins it; below a separator, after its mods | MO2 mod list | Add a mod separator next to a mod or a separator. | update-load-order-file |
| rename | writes | Mods: context menu, key (F2) | `modbench.separator.rename` | separator | - | MO2 mod list | Rename a mod separator. | update-load-order-file |
| delete | writes | Mods: context menu, key (Delete) | `modbench.separator.delete` | separators | - | MO2 mod list | Delete a mod separator. The mods under it join the separator above, or become ungrouped when it was the first. | update-load-order-file |

## Plugin

Offered on Plugins. The Plugins surface shows a plugin's origin mod, and its origin. Tracking gates every edit. An untracked plugin is read-only in the Editor, whose column names Track, or decompile in a tracked mod, so each is offered where the user meets that refusal.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|---|
| enable / disable | writes | Plugins: check box, key, context menu | `modbench.plugin.enable`, `modbench.plugin.disable` | plugins | - | MO2 plugin list | Flip each plugin's line in `plugins.txt`. Enable all is select all, then this gesture. | update-load-order-file |
| move | writes | Plugins: drag | `modbench.plugin.move` | plugins | target: the row it is dropped on, or the view's end. Several plugins move as one block | MO2 plugin list | Move plugins in plugin order. Masters stay above their dependants, and blueprint plugins stay last. | update-load-order-file |
| create | writes | Plugins: title icon | `modbench.plugin.create` | - | place: Overwrite or an enabled mod | xEdit navigator | Create an empty plugin in Overwrite or in a mod. | create-plugin |
| compile | writes | Plugins: context menu (plugin tracked and editable); Editor: context menu (plugin tracked and editable) | `modbench.plugin.compile` | plugins | - | xEdit main menu | Write the plugin's binary from its plugin source. A failed compile says so, and compiling again rebuilds the binary. | compile-plugin |
| decompile | writes | Plugins: context menu (plugin in a tracked mod); Editor: context menu (column of a plugin in a tracked mod) | `modbench.plugin.decompile` | plugins | - | none | Read each plugin's bytes into its plugin source, in the working tree of the checked-out branch. It commits nothing. | decompile-plugin |
| sort direction | reads | Plugins: title icon | `modbench.plugin.sortWinningAtTop`, `modbench.plugin.sortLosingAtTop` | - | - | MO2 plugin list | List plugins with the winning end at the top or at the bottom. | none |
| reveal | reads | Plugins: context menu | `modbench.plugin.reveal` | plugin | - | MO2 plugin list | Show a plugin file in VS Code's Explorer. | none |

## Record

Offered on Plugins (the record children) and on Editor (the record panel and Referenced By). A field gesture from the palette acts on the focused cell of the record tab in focus, and is in the palette only while one has focus.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|---|
| edit field | writes | Editor: webview message, key, drag | `modbench.record.editField` | record, plugin, field path | value: set, paste, or the value of another field by drag and drop | xEdit View grid; xEdit drag between columns | Change a field's value in plugin source. A plugin header is a record, and its fields are editable the same way. A record's FormID is a field: a new one changes the record's FormKey and nothing else, and updating the records that reference it is a script. | edit-record |
| add element | writes | Editor: context menu | `modbench.record.addElement` | array | value (a drop supplies it; otherwise a new element) | xEdit View grid | Add an element to an array field. | edit-record |
| remove element | writes | Editor: context menu, key | `modbench.record.removeElement` | element | - | xEdit View grid | Remove an element from an array field. | edit-record |
| move element | writes | Editor: context menu, key | `modbench.record.moveElementUp`, `modbench.record.moveElementDown` | element | - | xEdit View grid | Move an element one step in an array field. | edit-record |
| create | writes | Plugins: context menu | `modbench.record.create` | plugin, or a container | record type; containment, for a container | xEdit navigator | Add a record to a plugin. | edit-record |
| delete | writes | Plugins: context menu, key (Delete); Editor: context menu, key (Delete, on Referenced By) | `modbench.record.delete` | records | - | xEdit navigator, Referenced By, View header | Remove records from a plugin. The confirmation lists everything selected. | edit-record |
| copy | writes | Plugins: context menu; Editor: context menu | `modbench.record.copy` | records | mode: new or override; destination plugins; replace, for a destination that holds the record | xEdit navigator, Referenced By, View header; xEdit Inject Forms into master... | Copy records into other plugins. A picker asks for the mode and another for the destination. If a destination already holds a copy, a confirm asks whether to replace it. | edit-record |
| open | reads | Plugins: row click, context menu; Editor: context menu (Go to Record on a reference), row click, context menu, key (Referenced By) | `modbench.record.open` | records, or a reference field | placement: beside | xEdit navigator; xEdit Referenced By; xEdit Compare Selected; xEdit Ctrl + click | Open a record in an editor tab. Several records open each in a tab of their own. A plugin header is a record. A reference cell opens the record it points to, by the Go to Record menu item. With no Argument, a picker finds a record by EditorID, FormID or FormKey. | query-index |
| open field value | reads | Editor: context menu | `modbench.record.openFieldValue` | record, plugin, field path | - | xEdit View grid | Open a field value in an editor tab. | none |
| filter | reads | Plugins: title icon, code lens (on any SQL document) | `modbench.record.filter`, `modbench.record.clearFilter` | - | query: a `.sql` file, or a new document | xEdit navigator | Narrow the record tree to the FormKeys a SQL query returns. | query-index |

## Referrer

Offered on Editor, in Referenced By. A referrer is a record, listed because it references the active record.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|---|
| sort direction | reads | Editor: title icon (on Referenced By) | `modbench.referrer.sortAscending`, `modbench.referrer.sortDescending` | - | - | xEdit Referenced By | List referrers by record type, then label, or in reverse. | none |

## Downloaded file

Offered on Downloads.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|---|
| exclude / include | writes | Downloads: context menu | `modbench.downloadedFile.exclude`, `modbench.downloadedFile.include` | downloaded files | - | MO2 Downloads | Mark downloaded files hidden in their `.meta`, or restore them. `show excluded` decides whether the list shows them. | update-load-order-file |
| delete | writes | Downloads: context menu, key | `modbench.downloadedFile.delete` | downloaded files | - | MO2 Downloads | Delete downloaded files. | update-load-order-file |
| open | reads | Downloads: context menu | `modbench.downloadedFile.open` | downloaded file | - | MO2 Downloads | Open a downloaded file in its system application. | none |
| open `.meta` | reads | Downloads: context menu (the file has a `.meta`) | `modbench.downloadedFile.openMeta` | downloaded file | - | MO2 Downloads | Open a downloaded file's `.meta` in an editor tab. | none |
| sort | reads | Downloads: title overflow | `modbench.downloadedFile.sort` | - | field | MO2 Downloads | Choose the field the downloaded files sort by. | none |
| show excluded | reads | Downloads: title icon | `modbench.downloadedFile.showExcluded`, `modbench.downloadedFile.hideExcluded` | - | - | MO2 Downloads | Show or hide the excluded downloaded files. | none |

## System commands

Commands Modbench runs itself. No user starts them and no surface owns them, so they have no
gesture and sit outside the object tables. The first column is the trigger that fires each one.
Each is a command for the same reason a gesture is: one handler, and one identity. Each is
registered under its Command ID, internal. A system command
keeps the disk and mEdit in line with the instance value. Its trigger is a disagreement between
them. It takes the value, or the slice it needs, as its Argument, and it acts once, in every
direction the disagreement needs.

| Trigger | Effect | Command ID | Argument | Options | Template | Meaning | Trace |
|---|---|---|---|---|---|---|---|
| The load order changed: a `modlist.txt` or `plugins.txt` edit, or a change from another tool; or mEdit started | writes | `modbench.instance.putLoadOrder` | load order snapshot | - | none | Hand mEdit the whole load order snapshot whenever it changes. The architecture calls it a PUT. | index-load-order |
| The active profile's `modlist.txt` disagrees with `mods/`: a folder with no line, or a line whose folder is gone | writes | `modbench.mod.sync` | instance value | - | MO2 refresh | Bring the active profile's `modlist.txt` into line with `mods/`: add a line for each folder that has none, and drop each line whose folder is gone. One write. | update-load-order-file |
| The active profile's `plugins.txt` disagrees with the plugins provided: a plugin with no line, or a line that nothing provides | writes | `modbench.plugin.sync` | instance value | - | MO2 refresh | Bring `plugins.txt` into line with the plugins provided: add a line at the end, disabled, for each plugin that has none, and drop each line that nothing provides. One write. | update-load-order-file |