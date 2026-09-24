# Commands

This file owns the UX vocabulary and the catalog of gestures. `CONTEXT.md` owns the domain
vocabulary. A gesture or command the code has and this file lacks is a defect in the code.
A gesture this file has and the model cannot hold is a ticket.

- **Object**: a domain noun the user acts on: Instance, Profile, Mod, Separator, Plugin, Record,
  Referrer, Downloaded file. `CONTEXT.md` defines each one.
- **Surface**: what a driving box presents to the user. One surface per driving box on the
  Modbench side. A surface shows objects and offers their gestures. A VS Code view or an editor
  realizes it.
- **Gesture**: one thing the user does to an object. One row in the tables below, under the
  object it changes. The Gesture column holds the verb the user sees, in a menu or a label.
- **Exclude and hide**: to exclude is to mark an object durably on disk, so it is left out of
  something until include clears the mark: a downloaded file out of its list, a mod's file out of
  deployment. To hide is a view's own lens: it changes nothing on disk and ends with the window,
  like hide excluded or a filter.
- **System command**: a command Modbench runs itself. No user starts it and no surface owns it, so it
  has no gesture. Its first column is the trigger that fires it. It has its own section, after the
  objects.
- **Where**: the entry points of the gesture, surface by surface, as `<surface>: <entry point>`
  with a condition in brackets, separated by semicolons. It states the model, not the code. The
  entry points are `context menu`, `title icon`, `title overflow`, `inline button`, `row click`, `key`
  (a default chord goes in brackets), `drag`, `check box`, `webview message`, `dialog answer`, `code
  action` and `automatic`. A gesture is absent, not refused, where its condition is false. Every
  gesture is also in the command palette, unless it is marked internal. An **internal** command is
  registered under its Command ID and has no entry point and no palette entry.
- **Effect**: `writes` when the gesture ends in a Core command that writes a file, a repository
  or a folder. `reads` when it only changes what the surface shows, or opens something. `runs`
  when it starts another program and writes nothing itself.
- **Command ID**: the registered interface and the source of truth, which the code reflects. It is
  `modbench.<object>.<verb>`, in camelCase, and the object owns it (`modbench.mod.enable`,
  `modbench.downloadedFile.delete`). `-` means the gesture has none. A toggle or opposite pair has one
  ID per direction. A row that lists more than one ID, other than a pair, is `debt`. So is a
  registered ID that differs from the target here.
- **Options**: the inputs a gesture needs besides its Argument, such as a mode, a destination or a
  position. A picker asks for each Option the caller did not supply. An Option may be computed
  and multi-valued, such as a checked list with defaults.
- **Argument**: the value that identifies the object or objects to the gesture, such as a plugin
  name or a FormKey. For a gesture that creates an object, it identifies the container, when the
  entry point is on the container's row. A create from a title icon has none, and its container is
  an Option. It is the same on every surface that offers the gesture. Singular means the clicked
  row, and plural means the whole selection. A handler that receives anything else is `debt`.
- **Template**: the source, xEdit ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md))
  or MO2 ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)) gesture this row
  follows, read from [the xEdit audit](../research/xedit-surface-audit.md),
  [the xEdit grid audit](../research/xedit-ux-audit.md) and
  [the MO2 audit](../research/mo2-surface-audit.md). `none` means the template has no such
  gesture: the row is an addition or a divergence, and needs a ruling.
- **Trace**: the sequence diagram of the gesture's flow. A gesture that is not built has none,
  because drawing the trace is part of designing the gesture. A built gesture with `-` has a trace
  still to draw, and `none` that it has no flow between boxes: its specification is this row and its
  surface. Gestures whose arrows are the same share one diagram. Beside each diagram, a `.md` file of
  the same name holds the contract: what the flow promises, step by step, where it hands off, what
  it refuses, and what a failure leaves.
- **Ruled out**: a gesture the maintainer has cut is not in any table. See
  [Ruling a gesture out](#ruling-a-gesture-out).

A toggle or an opposite pair (enable and disable, move up and move down) is one row with both
directions, and both Command IDs. Any other gesture has one Command ID. A gesture that appears on several surfaces has one row, and each surface adapts its
own item to the Argument.

Status: `built`, `drawn` (in the zoom-out and a trace, not built), `planned`, `word-only`, `?`
(not verified), `unspecified` (the code exists and the maintainer has not specified it; a row
leaves it when its contract is accepted), or `debt #NNN` (the code breaks this model, and the
ticket names the fix).

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
- **A gesture is atomic.** It does one thing the user can name. A convenience that chains gestures
  the user already has, such as installing and then moving, is planned and never part of the alpha.
  Until it ships, the user runs the gestures in turn.
- **Entry points are not gestures.** Every gesture is a command. The palette lists it, and the user
  can bind a key to it. A menu item, a default key or a mouse click is an entry point to the same
  command, not a second gesture.
- **An entry point fires a gesture. A gesture does not fire another.** An entry point on any
  surface may fire any gesture through the command registry. It passes the Argument and uses no
  result, as a click on a plugin row opens its header. A gesture that needs another box's work as
  a step, and acts on its outcome, calls that box through a reference the reference view draws.
- **One identity.** The Command ID is the identity of a gesture. The Gesture column is the verb
  the user sees for it, and the palette title is that verb plus the object ("Modbench: Rename Mod").
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
- **Confirm what destroys.** A gesture that deletes or overwrites asks first, once for the whole
  selection. Any other gesture does not ask. A contract names an exception.
- **A write is forgotten.** A gesture that changes an MO2 file writes it and keeps no copy of the
  new state. The watch reads the file back, and every view updates from the new instance value. A
  view shows the old state until the disk says otherwise.
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

The xEdit Messages tab is not a surface. Failures go to the Problems panel (ADR-0019).

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

## Instance

Offered on Toolbox. Run entries are not an object yet; the run-list gestures name them `run entry`.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|
| deploy / purge | writes | Toolbox: title overflow (an MO2 instance is open) | `modbench.instance.deploy`, `modbench.instance.purge` | - | - | none | Toggle between deployed and not deployed. Purge asks for confirmation. Deploy is a state, separate from `run`, and purge never runs on its own. | planned | - |
| run | runs | Toolbox: title icon (an MO2 instance is open) | `modbench.instance.run` | run entry | - | MO2 run box | Start the game or another executable from MO2's run list, as a VS Code task. | planned | - |
| select game | ? | Toolbox: ? | `modbench.instance.selectGame` | game | - | MO2 toolbar | Choose the game the instance is for. | ? | - |
| open settings | reads | Toolbox: ? | `modbench.instance.openSettings` | - | - | MO2 toolbar | Open the Modbench settings. | ? | none |
| refresh | writes | Toolbox: title icon | `modbench.instance.refresh` | - | - | MO2 toolbar | Drop and rebuild the index and re-read every source from disk. One gesture for all of Modbench. It is a safety net, not how changes normally arrive. It is refused while another window holds the index. | debt #967 | load-instance |
| add executable | writes | Toolbox: context menu | - | run entry | - | MO2 Executables dialog | Add an executable to the run list in `ModOrganizer.ini`, as a task. | planned | - |
| remove executable | writes | Toolbox: context menu | - | run entries | - | MO2 Executables dialog | Remove an executable from the run list. | planned | - |
| edit executable | writes | Toolbox: context menu | - | run entry | field | MO2 Executables dialog | Change the fields of a run-list entry. Reordering and resetting the list are open. | planned | - |
| set up instance | writes | Toolbox: context menu | - | instance | - | none | Create `mods/`, `profiles/`, `modlist.txt` and the config for a new instance. | planned | - |
| track modlist | writes | ? | - | instance | - | none | Put the modlist under git, and rebuild it from git state and download targets. The design is open. | planned | - |
| log in | writes | Toolbox: dialog answer | - | - | - | MO2 settings | Store a Nexus API key in VS Code's secret storage. | planned | - |
| run script | runs | Plugins: ? | - | script | debug | xEdit navigator | Run a Python script over the load order, a record or a plugin. Option: run it under the debugger. | planned | - |
| cancel | ? | Toolbox: context menu, key; Downloads: context menu, key | - | a running operation: a download, Track, a large copy | - | MO2 Downloads | Stop a running operation. | planned | - |

## Profile

Offered on Toolbox. A Profile is part of the Instance.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|
| switch | writes | Toolbox: row click | `modbench.profile.switch` | profile | - | MO2 profile combo | Change the active MO2 profile. With no Argument, a picker lists the profiles. | debt #967 | update-load-order-file |
| create | writes | Toolbox: dialog answer | ? | source profile, or none | - | MO2 Profiles dialog | Create a profile, empty or copied from another. | planned | - |

## Mod

Offered on Mods, and on Downloads for install. The Overwrite row is a mod-list row, not a mod; its `Argument` is `overwrite`.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|
| enable / disable | writes | Mods: check box, key, context menu | `modbench.mod.enable`, `modbench.mod.disable` | mods | - | MO2 mod list | Flip each mod's line in `modlist.txt`. Enable all is select all, then this gesture. | ? | update-load-order-file |
| move | writes | Mods: drag, context menu | `modbench.mod.move` | mods or separators | target: a separator (built); top, bottom, priority N, first or last conflict (planned) | MO2 mod list | Move mods in mod order. | debt #956, #967 | update-load-order-file |
| uninstall | writes | Mods: context menu, key (Delete) | `modbench.mod.uninstall` | mods | - | MO2 mod list | Move a mod folder to the trash and remove its line. | debt #967 | update-load-order-file |
| rename | writes | Mods: context menu, key | - | mod | - | MO2 mod list | Rename a mod's folder and its name in every profile's `modlist.txt`. | planned | - |
| create empty mod | writes | Mods: context menu, title overflow | `modbench.mod.createEmpty` | - | position (planned) | MO2 mod list | Create an empty mod folder and its line. | debt #967 | update-load-order-file |
| install | writes | Mods: context menu, title overflow; Downloads: context menu | `modbench.mod.install` | source: archive, folder or downloaded file | position (planned); target mod, for an upgrade; reinstall from the recorded archive (planned); installer: quick, manual or FOMOD (planned) | MO2 mod list; MO2 Downloads | Install a source as a new mod, or over a mod with the same Nexus id when the user confirms the target. That is an upgrade. A downloaded file supplies its own source; the Mods menu asks for one. | debt #959, #967 | install-mod |
| open details | reads | Mods: context menu, double click; Plugins: context menu, double click | - | mod, separator, or a plugin's origin mod | tab | MO2 mod list; MO2 plugin list | Open the mod details view. Its conflicts tab lists the conflicting mods and opens each one. | planned | - |
| highlight conflicts | reads | Mods: automatic; Plugins: automatic | - | mods | - | MO2 mod list | Mark the mods that conflict with the selection. | planned | - |
| exclude / include file | writes | Mods: context menu | - | files in a mod | - | MO2 Information dialog, Conflicts tab; MO2 mod list | Keep a file out of the deployed Data folder by renaming it with MO2's `.mohidden` suffix, or restore it. It does not change what any list shows. | planned | - |
| check for updates | writes | Mods: context menu | - | mods (all, or the selection) | - | MO2 mod list | Ask Nexus for the latest version of each mod and set the update badge. | planned | - |
| track | writes | Mods: context menu (mod holds an untracked plugin) | `modbench.mod.track` | mods | preset: Edits or Everything | none | Put every untracked plugin the mod holds under git, as `track` on each plugin does: one baseline commit per plugin. | debt #966, #967 | decompile-plugin |
| rebase edit branch | writes | Plugins: context menu (mod tracked, no rebase in progress) | `modbench.mod.rebaseEditBranch` | tracked mods | - | none | Replay the edit branch onto `main`. Nothing else rebases it. | debt #967 | decompile-plugin |
| sort direction | reads | Mods: title icon | `modbench.mod.sortWinningAtTop`, `modbench.mod.sortLosingAtTop` | - | - | MO2 mod list | List mods with the winning end at the top or at the bottom. | debt #967 | none |
| filter | reads | Mods: title icon, key (Ctrl+F) | `modbench.mod.filter`, `modbench.mod.clearFilter` | - | - | MO2 mod list | Narrow the mod list by name. | debt #967 | none |
| open folder | reads | Mods: context menu | `modbench.mod.openFolder` | mod, or overwrite | - | MO2 mod list, Overwrite row | Show a mod's files in the native file tab, decorated by conflict status (planned; today the file explorer). The Overwrite row opens the overwrite folder. | debt #967 | none |
| view on Nexus | reads | Mods: context menu (mod has a Nexus id); Downloads: context menu (file has a Nexus id) | `modbench.mod.viewOnNexus` | mod, or downloaded file | - | MO2 mod list; MO2 Downloads | Open the mod's Nexus page. The address comes from the mod's `meta.ini`, or from the downloaded file's `.meta`. | debt #956, #967 | none |
| publish | writes | Mods: context menu | - | mod | - | none | Publish an update for a mod the user owns, through the Nexus API. | planned | - |

## Separator

Offered on Mods. A separator is a row in mod order.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|
| add | writes | Mods: context menu | `modbench.separator.add` | mod or separator (the anchor) | position: above a mod, which joins it; below a separator, after its mods; inside (planned) | MO2 mod list | Add a mod separator next to a mod or a separator. | debt #960, #967 | update-load-order-file |
| rename | writes | Mods: context menu, key (F2) | `modbench.separator.rename` | separator | - | MO2 mod list | Rename a mod separator. | debt #967 | update-load-order-file |
| delete | writes | Mods: context menu, key (Delete) | `modbench.separator.delete` | separators | - | MO2 mod list | Delete a mod separator. The mods under it join the separator above, or become ungrouped when it was the first. | debt #967 | update-load-order-file |

## Plugin

Offered on Plugins. The Plugins surface shows a plugin's origin mod, so it offers the reduced mod set: open the origin folder and the origin's information. Tracking gates every edit. An untracked plugin is read-only in the Editor, whose column names Track, so `track` is offered where the user meets that refusal.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|
| enable / disable | writes | Plugins: check box, key, context menu | `modbench.plugin.enable`, `modbench.plugin.disable` | plugins | - | MO2 plugin list | Flip each plugin's line in `plugins.txt`. Enable all is select all, then this gesture. | ? | update-load-order-file |
| move | writes | Plugins: drag, context menu | `modbench.plugin.move` | plugins | target: top, bottom, priority N (planned). Several plugins move as one block (planned) | MO2 plugin list | Move plugins in plugin order. Masters stay above their dependants, and blueprint plugins stay last. | ? | update-load-order-file |
| create | writes | Plugins: title icon | `modbench.plugin.create` | - | place: Overwrite or an enabled mod; a new mod (planned) | xEdit navigator | Create an empty plugin in Overwrite or in a mod. | debt #977 | create-plugin |
| track | writes | Plugins: context menu (plugin untracked, in a mod); Editor: context menu (column of an untracked plugin in a mod) | `modbench.plugin.track` | plugins | preset: Edits or Everything | none | Put each plugin under git, in its mod's repository. It fires `decompile plugin` with the repository as the destination: it creates the repository if the mod has none, commits each plugin's baseline to `main` as its own commit, and checks out the edit branch. The mod's other plugins stay as they are. | debt #966, #967 | decompile-plugin |
| compile | writes | Plugins: context menu (plugin tracked and editable); Editor: context menu (plugin tracked and editable) | `modbench.plugin.compile` | plugins | source: working tree, or `main` | xEdit main menu | Write the plugin's binary from its plugin source. A failed compile says so, and compiling again rebuilds the binary. | debt #961, #967 | compile-plugin |
| repair | writes | Plugins: context menu | - | plugins | - | none | Rewrite a malformed plugin into its canonical form. | planned | - |
| validate | reads | Plugins: context menu, automatic; Toolbox: context menu, automatic | - | plugins, or the instance | check kinds | xEdit navigator | Report problems in the Problems panel: structural, load order, missing assets. | planned | - |
| filter | reads | Plugins: title icon, key (Ctrl+F) | `modbench.plugin.filter`, `modbench.plugin.clearFilter` | - | - | MO2 plugin list; xEdit navigator | Narrow the plugin list by name. | debt #967 | none |
| sort direction | reads | Plugins: title icon | `modbench.plugin.sortWinningAtTop`, `modbench.plugin.sortLosingAtTop` | - | - | MO2 plugin list | List plugins with the winning end at the top or at the bottom. | planned | none |
| reveal | reads | Plugins: context menu | `modbench.plugin.reveal` | plugin | - | MO2 plugin list | Show a plugin file in the file explorer. | debt #967 | none |
| highlight origin | reads | Plugins: automatic; Mods: automatic | - | plugins, or mods | - | MO2 plugin list | Selecting a plugin marks its origin mod and its masters. Selecting a mod marks the plugins it provides. | planned | - |
| add sort rule | writes | Plugins: context menu | - | - | rule | none | Add a plugin sorting rule. A hard rule is red and a soft rule is yellow. | planned | - |
| edit sort rule | writes | Plugins: context menu | - | sort rule | field | none | Change a sorting rule. | planned | - |
| enable / disable sort rule | writes | Plugins: context menu | - | sort rules | - | none | Turn a sorting rule on or off. | planned | - |
| remove sort rule | writes | Plugins: context menu | - | sort rules | - | none | Remove a sorting rule. | planned | - |
| apply suggested sort | writes | Plugins: code action | - | plugin | - | none | Fix a sorting problem by applying the suggested position. The problem shows as a squiggle. | planned | - |
| rename | writes | Plugins: context menu | - | plugin | new name | none | Rename a plugin and its source tree. Updating the master reference in every dependent is a script. | planned | - |
| relink source | writes | Plugins: dialog answer | - | plugin | - | none | A plugin was renamed outside Modbench: move its source tree to the new name. | planned | - |
| remove source | writes | Plugins: dialog answer | - | plugin | - | none | A plugin was deleted outside Modbench: remove its source tree, as a working-tree deletion the user reviews. | planned | - |

## Record

Offered on Plugins (the record children) and on Editor (the record panel and Referenced By). Following xEdit, create, renumber and filter are Plugins only; field gestures are Editor only; the rest are on both. A field gesture from the palette acts on the focused cell of the record tab in focus, and is in the palette only while one has focus.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|
| edit field | writes | Editor: webview message, key, drag | `modbench.record.editField` | record, field path | value: set, paste, or the value of another field by drag and drop | xEdit View grid; xEdit drag between columns | Change a field's value in plugin source. A plugin header is a record, and its fields are editable the same way. | ? | edit-record |
| add element | writes | Editor: context menu, key | `modbench.record.addElement` | array | value (a drop supplies it; otherwise a new element) | xEdit View grid | Add an element to an array field. Sorted arrays add too (planned). | debt #967 | edit-record |
| remove element | writes | Editor: context menu, key | `modbench.record.removeElement` | elements | - | xEdit View grid | Remove an element from an array field. Sorted arrays remove too (planned). | debt #967 | edit-record |
| move element | writes | Editor: context menu, key | `modbench.record.moveElementUp`, `modbench.record.moveElementDown` | element | - | xEdit View grid | Move an element one step in an unsorted array. Sorted arrays have no move. | debt #967 | edit-record |
| create | writes | Plugins: context menu | `modbench.record.create` | plugin, or a container | record type; containment, for a container (planned) | xEdit navigator | Add a record to a plugin. | built | edit-record |
| delete | writes | Plugins: context menu, key (Delete); Editor: context menu, key (Delete, on Referenced By) | `modbench.record.delete` | records | - | xEdit navigator, Referenced By, View header | Remove records from a plugin. The confirmation lists everything selected. | built | edit-record |
| renumber | writes | Plugins: context menu | `modbench.record.renumber` | records, or a plugin | start id, for a plugin (planned) | xEdit navigator | Change a record's FormKey. Updating the records that reference it is a script. | built | edit-record |
| copy | writes | Plugins: context menu; Editor: context menu | `modbench.record.copy` | records | mode: new, override, underride (planned); destination plugins; replace, for a destination that holds the record; deep, for containers (planned) | xEdit navigator, Referenced By, View header; xEdit Inject Forms into master... | Copy records into other plugins. A picker asks for the mode and another for the destination. If a destination already holds a copy, a confirm asks whether to replace it. | debt #962, #967 | edit-record |
| open | reads | Plugins: row click, context menu; Editor: context menu (Go to Record on a reference), row click (Referenced By) | `modbench.record.open` | records, or a reference field | placement: beside | xEdit navigator; xEdit Referenced By; xEdit Compare Selected; xEdit Ctrl + click | Open a record in an editor tab. Several records open each in a tab of their own; one comparison over several is planned (#23). A plugin header is a record. A reference cell opens the record it points to, by the Go to Record menu item. With no Argument, a picker finds a record by FormID or EditorID. | debt #963, #967 | query-index |
| open field value | reads | Editor: context menu | `modbench.record.openFieldValue` | record, field path | - | xEdit View grid | Open a field value in an editor tab. | debt #967 | none |
| filter | reads | Plugins: title icon, code action (on a `.sql` file) | `modbench.record.filter`, `modbench.record.clearFilter` | - | query source: input box, or a document | xEdit navigator | Narrow the record tree to the FormKeys a SQL query returns. | debt #964, #967 | query-index |
| show referenced by | reads | Editor: automatic | `modbench.record.showReferencedBy` | active record | - | xEdit Referenced By tab | The Referenced By list follows the active record and shows the records that reference it. It has no menu entry; the command only focuses the view. | debt #967 | query-index |
| hide no-conflict rows | reads | Editor: context menu | - | - | - | xEdit View grid | Collapse the compare grid to the rows that conflict. A toggle. | planned | - |
| copy value | reads | Mods: context menu, key; Plugins: context menu, key; Editor: context menu, key | `modbench.record.copyValue` | selection | - | xEdit navigator, Referenced By, View grid; MO2 mod list | Copy the selected rows, or a focused cell value, to the clipboard. Each surface says what a row copies. | debt #967 | none |

## Referrer

Offered on Editor, in Referenced By. A referrer is a record, listed because it references the active record.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|
| filter | reads | Editor: title icon (on Referenced By), key (Ctrl+F, on Referenced By) | `modbench.referrer.filter`, `modbench.referrer.clearFilter` | - | - | xEdit Referenced By | Narrow the Referenced By list by name. | planned | none |
| sort direction | reads | Editor: title icon (on Referenced By) | `modbench.referrer.sortAscending`, `modbench.referrer.sortDescending` | - | - | xEdit Referenced By | List referrers by record type, then label, or in reverse. | planned | none |

## Downloaded file

Offered on Downloads.

| Gesture | Effect | Where | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|---|
| exclude / include | writes | Downloads: context menu | `modbench.downloadedFile.exclude`, `modbench.downloadedFile.include` | downloaded files | - | MO2 Downloads | Mark downloaded files hidden in their `.meta`, or restore them. `show excluded` decides whether the list shows them. | debt #956, #967 | update-load-order-file |
| delete | writes | Downloads: context menu, key | `modbench.downloadedFile.delete` | downloaded files | - | MO2 Downloads | Delete downloaded files. | debt #967 | update-load-order-file |
| download | writes | automatic | - | - | source: an nxm:// link (planned) | MO2 download manager | Fetch a mod file into `downloads/`. Modbench does not do this yet. | word-only | - |
| pause / resume | writes | Downloads: context menu, key | - | downloaded files (running downloads) | - | MO2 Downloads | Pause a running download, or resume it. | planned | - |
| open | reads | Downloads: context menu | `modbench.downloadedFile.open` | downloaded file | - | MO2 Downloads | Open a downloaded file in its system application. | debt #991 | none |
| open `.meta` | reads | Downloads: context menu (the file has a `.meta`) | `modbench.downloadedFile.openMeta` | downloaded file | - | MO2 Downloads | Open a downloaded file's `.meta` in an editor tab. | debt #991 | none |
| query info | writes | Downloads: context menu | - | downloaded files | - | MO2 Downloads | Look a downloaded file up on Nexus by hash and fill its `.meta`. | planned | - |
| filter | reads | Downloads: title icon, key (Ctrl+F) | `modbench.downloadedFile.filter`, `modbench.downloadedFile.clearFilter` | - | - | MO2 Downloads | Narrow the downloaded files by name. | debt #967 | none |
| sort | reads | Downloads: title overflow | `modbench.downloadedFile.sort` | - | field | MO2 Downloads | Choose the field the downloaded files sort by. | debt #967 | none |
| show excluded | reads | Downloads: title icon | `modbench.downloadedFile.showExcluded`, `modbench.downloadedFile.hideExcluded` | - | - | MO2 Downloads | Show or hide the excluded downloaded files. | debt #956, #967 | none |
| reveal installed mod | reads | Downloads: context menu | - | downloaded file | - | none | Show the mod that a downloaded file was installed as. | planned | - |

## System commands

Commands Modbench runs itself. No user starts them and no surface owns them, so they have no
gesture and sit outside the object tables. The first column is the trigger that fires each one.
Each is a command for the same reason a gesture is: one handler, and one identity. Each is
registered under its Command ID, internal. A system command
keeps one file in line with what is on disk. Its trigger is the instance value disagreeing with the
disk, it takes the value as its Argument, and it writes the file once, in every direction the
disagreement needs.

| Trigger | Effect | Command ID | Argument | Options | Template | Meaning | Status | Trace |
|---|---|---|---|---|---|---|---|---|
| The load order changed: a `modlist.txt` or `plugins.txt` edit, or a change from another tool | writes | `modbench.instance.putLoadOrder` | load order snapshot | - | none | Hand mEdit the whole load order snapshot whenever it changes. The architecture calls it a PUT. | built | index-load-order |
| The active profile's `modlist.txt` disagrees with `mods/`: a folder with no line, or a line whose folder is gone | writes | `modbench.mod.sync` | instance value | - | MO2 refresh | Bring the active profile's `modlist.txt` into line with `mods/`: add a line for each folder that has none, and drop each line whose folder is gone. One write. | debt #991 | update-load-order-file |
| The active profile's `plugins.txt` disagrees with the plugins provided: a plugin with no line, or a line that nothing provides | writes | `modbench.plugin.sync` | instance value | - | MO2 refresh | Bring `plugins.txt` into line with the plugins provided: add a line at the end, disabled, for each plugin that has none, and drop each line that nothing provides. One write. | debt #991 | update-load-order-file |
| The watcher settles a tracked mod that changed: a moved `meta.ini` version means a new release, otherwise an edit in another tool | writes | `modbench.plugin.decompile` | plugins of a tracked mod | destination: `main` when the `meta.ini` version moved (a new release), else the working tree (an edit in another tool); it asks first: one question per mod, its default pre-selected by the `meta.ini` version (ADR-0003, invariant 3) | none | The watcher classifies an external change and calls `decompile plugin`, which reads the plugin's bytes back into plugin source. The two `track` gestures call the same command with the mod's repository as the destination. | debt #966 | decompile-plugin |
