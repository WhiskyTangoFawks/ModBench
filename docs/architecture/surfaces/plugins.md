# Plugins

The Plugins surface shows the plugin order and, beneath each plugin, its records. It is one tree
over two templates: its plugin rows follow MO2's plugin list
([ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md)), and the records beneath
them follow xEdit's navigator
([ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md)). Where it departs,
[mo2.md](../../out-of-scope/mo2.md) and [xedit.md](../../out-of-scope/xedit.md) say why. Its
gestures are in [commands.md](../commands.md) under Plugin and Record, with `track` and `rebase
edit branch` under Mod; what each one writes is in its trace. What every view shares is in
[common.md](common.md).

Each story cites its source. A story with no source is owned here.

## The view

A native tree view, `modbench.pluginListTree`, third in the `modbench` container and open by
default (commands.md, Where surfaces live). It has Collapse All (Chrome). Its plugin rows need only
the instance value. What a row holds beneath it needs mEdit, and no view has a mode for mEdit's
absence
([ADR-0002](../../adr/0002-mod-management-and-editing-are-one-tool.md), invariant 2).

The view's description shows the name filter's term and the record filter's source while each is
active: `"arm" · records: armor.sql`.

## The tree

As a user, I want:

1. One row for each line of the active profile's `plugins.txt`, in its order, first loaded at the
   top. *MO2*
2. The plugins the game loads with no line first, above every line, locked. *MO2*
3. A losing copy of a plugin, one the game does not load because another mod's copy of the same name
   wins, not to be a row. It stays indexed, and viewing it is deferred. *ADR-0012, invariant 5*
4. Every plugin row to expand at any time. Expanding decides what it shows: its records, "Still
   indexing…", or the error row, never an empty list that reads as "no records". *ADR-0019,
   invariant 1*
5. Beneath a plugin, one group for each record type it holds, named as xEdit names it ("Activator"),
   sorted by name, the worldspaces and cells among the rest. *xEdit sorts its navigator by name*
6. Beneath a group, its records. A container record holds its children directly, as xEdit folds a
   record's child group into the record: a worldspace holds its persistent cell and its blocks, a
   block its sub-blocks, a sub-block its cells, a cell its persistent and temporary placed
   references, a quest its dialog topics, and a dialog topic its responses. *xEdit*
7. A row with nothing beneath it to show no expander, and an empty group of placed references not to
   be a row. *xEdit*
8. Beneath a group, the records in FormID order. *xEdit*
9. Every record at once, with no paging: xEdit shows the full list, and VS Code renders only what is
   on screen.
10. Every row collapsed each time the extension activates, so the view opens clean. *ruling, as
    in Mods*

## A row

### Plugin

| Part | What it shows | Source |
|---|---|---|
| Label | the plugin's file name | MO2 |
| Check box | checked when its line is enabled | MO2 |
| Description | the status words below, left out when the plugin has none | common, A view, story 3 |
| Icon | the status below; none when the plugin has no status | common, A view, story 3 |
| Tooltip | the file name, the mod it comes from, "read-only" when its records cannot be edited, and a line for each status | ADR-0012, invariant 3 |
| Identity | the row's kind and the file name | |

A plugin's statuses, the first in this order sets the icon, and the tooltip lists every one:

| Status | When | Icon | Words |
|---|---|---|---|
| Failed to load | mEdit could not load it | `$(error)` red | failed to load |
| Master issues | a master it lists is missing or cannot be loaded, once the load order is indexed | `$(error)` red | N master issues |
| Unreadable records | a record could not be read into its document | `$(error)` red | unreadable records |
| Malformed | its bytes depart from what the Creation Kit writes | `$(warning)` yellow | malformed |

A master issue never disables the plugin or cascades to its dependants: the check box stays as I set
it (ADR-0012, invariant 4). Before the load order is indexed, a plugin has no master verdict, so no
badge means not yet asked. A malformed plugin's reasons are also in the Problems panel, on the
plugin file. *ADR-0019*

### A plugin the game loads with no line

| Part | What it shows | Source |
|---|---|---|
| Label | the file name, greyed | MO2 |
| Check box | none: VS Code has no check box that cannot be changed, so a lock stands in | |
| Icon | `$(lock)` | |
| Tooltip | "This plugin can't be disabled or moved (enforced by the game)." | MO2's wording |

It cannot be dragged. A `plugins.txt` line that names one is not a second row.

### Record-type group

| Part | What it shows | Source |
|---|---|---|
| Label | the type's name, as xEdit names it | xEdit |
| Description | how many records it holds | xEdit's child count |
| Icon | `$(error)` red when a record beneath it could not be read; none otherwise | |

### Record

| Part | What it shows | Source |
|---|---|---|
| Label | the EditorID, or the FormKey when it has none | xEdit |
| Description | the FormKey | xEdit; CONTEXT.md, FormKey |
| Icon | `$(error)` red when it, or a record beneath it, could not be read; none otherwise | |
| Tooltip | its name, when it has one, and the reason it could not be read | xEdit's third column |
| Badge | `M` modified and `A` added, in git's colours, while its plugin source has working-tree changes | ADR-0007; VS Code's source control badges |
| Identity | the row's kind, the plugin's file name and the FormKey | |

A block, a sub-block and a cell without a name take xEdit's labels: "Block x, y", "Sub-Block x, y",
and the cell's grid position. A placed reference without an EditorID takes its base record's. *xEdit*

### Rows that stand in for records

| Row | When | What it shows |
|---|---|---|
| Still indexing | mEdit does not hold the plugin yet | "Still indexing…", `$(loading~spin)` |
| Error | reading what the row holds failed | common, States, story 2 |

## Order and view state

As a user, I want:

1. Losing at the top until I choose otherwise, and a title-bar toggle that flips the plugin rows to
   winning at the top. It never changes which plugin wins, and the groups and records beneath keep
   their order. *common, A view, story 7; MO2's priority sort*
2. The name filter to match plugin rows. *common, The name filter*
3. The record filter to narrow the records to the FormKeys a SQL query returns. Its title-bar slot
   becomes a clear icon while it is active, and the view's description names its source, never its
   SQL. It is its own filter, beside the name filter. *catalog `filter` under Record; Chrome*
4. A plugin with no record left under the record filter hidden while it is active. *ruling*
5. The record filter to live in mEdit, so it survives a reload and clears only on purpose.

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no lines and no plugins the game loads on its own, a message saying so, in the view's
   message line.
2. While mEdit starts and indexes, the view's progress bar under its title, and every plugin row
   already there. A row whose plugin is not indexed yet expands to "Still indexing…", never to an
   error. Progress lives in the view header, never a notification.
3. While mEdit is unreachable, the rows and their statuses to stay. A row expands to the error row
   with the reason, and the status bar says mEdit is down. The tree never changes shape. *ADR-0002,
   invariant 2*
4. When another window holds the instance's index, every row to expand to the error row naming that,
   never to "Still indexing…" for ever. *ADR-0009*
5. When the record filter matches nothing, a message saying so, naming its source. *common, The name
   filter, story 6*
6. The title bar's gestures absent while the folder is not an instance. *No dead entries*

## Menus and keys

The catalog decides which gestures this view offers and on what condition. This is where each sits,
in VS Code's groups: open, change, create, source control, copy, then destroy.

| Where | Items, in order |
|---|---|
| Title bar | 1: filter, or clear filter while active. 2: sort direction. 3: filter records, or clear the record filter while active. 4: create plugin. Collapse All last. |
| Plugin menu | reveal · enable or disable · create record… · track… · compile · compile from `main`… · rebase edit branch · copy value |
| Plugin the game loads with no line | reveal · copy value |
| Record-type group menu | create record |
| Record menu | open to the side · copy… · renumber… · copy value · delete |
| Keys | Space: enable or disable. Enter: open, as a click does. Delete: delete records. Ctrl+C: copy value. Ctrl+F: filter. |

As a user, I want:

1. Each menu item to act on the row I right-clicked, or on the whole selection, as the gesture's
   Argument in the catalog says: enable or disable, delete, copy and open take the selection.
   *catalog Argument*
2. Keys and mouse that do what VS Code's trees do. *common, A view, story 5*
3. A click on a record to open it in the record panel, and a click on a plugin row to open its
   header, which is a record. *catalog `open`*
4. Enable or disable over a mixed selection, and the check box, to behave as in Mods (Menus and keys,
   stories 3 and 5). *mods.md*
5. `track` and `rebase edit branch` to act on the plugin's mod, and each offered only where the
   catalog's condition holds: track on an untracked mod's plugin, rebase and compile on a tracked,
   editable plugin. *catalog Where*

## Drag and drop

As a user, I want:

1. To drag plugin rows, one or several. They move as one block in their `plugins.txt` order.
2. A drop on a plugin row to place the block directly above it, as shown; on a plugin the game loads
   with no line, next to those plugins; below the last row, at the bottom of the view, as shown.
3. A drop that would put a master below a plugin that depends on it, or a blueprint plugin before
   another, refused, naming the plugin and the master. *update-load-order-file, plugin move, story 2*
4. A drop where the block cannot go to change nothing and say nothing: on a record, a group, or a
   row being dragged. *mods.md, Drag and drop, story 5*
5. Records, groups and the locked rows not to drag, and nothing from outside the view to drop here.
   *xedit.md: Drag a record onto a reference field*

## Pickers, prompts and confirmations

### Create plugin

As a user, I want a pick of where it lives, the mods and Overwrite, then a prompt for the name that
refuses an empty name, anything but `.esp`, `.esm` or `.esl`, and a name a plugin in that place
already has. The same name elsewhere in the load order is not checked. Esc at either step creates
nothing. *catalog `create`: the mod is the Argument; ruling*

### Track

As a user, I want a pick of the preset, `Edits` first and pre-selected, then `Everything`, each with a
line saying what it keeps. Esc tracks nothing. While it runs, the view's message line names the mod
and the phase. *catalog `track`; decompile-plugin contract, story 2*

### Compile

As a user, I want:

1. `compile` to build from the working tree. Whether it asks first is the compile contract's
   question 1.
2. `compile from main…` to confirm first, saying my edit branch and working tree stay as they are.
   *catalog `compile`, source Option; compile-plugin contract, story 13*
3. The view's progress bar while it runs, and a notification when it lands, pointing at the Problems
   panel when it left diagnostics.
4. A plugin whose records do not fit ESL to ask whether to remove the flag and compile.

### Create record

As a user, I want, on a group, a new record of that type with no prompt, and on a plugin a pick of the
record type first. The new record is selected and opens in the record panel. *catalog `create`
under Record, record type Option; xEdit selects what it adds*

### Renumber

As a user, I want a prompt filled with the next free ID and selected, where an empty answer takes the
suggestion. Renumber changes this record's FormKey and nothing else: updating the records that
reference it is a script (xedit.md, divergence 11). When other records reference it, a confirmation
says how many will point at nothing until they are updated. Esc renumbers nothing. *catalog
`renumber`; ruling*

### Copy

As a user, I want a pick of the mode, then a pick of the destination: the plugins I can edit, each
with its load position. A destination that already holds a copy asks whether to replace it. Esc on
either copies nothing. *catalog `copy`; edit-record contract*

### Delete

As a user, I want one confirmation listing everything selected, saying the records leave their
plugin source as working-tree changes I can review. *catalog `delete`; Confirm what destroys*

### Record filter

As a user, I want a pick of the `.sql` files in my scripts folder, then "New filter…", which opens an
untitled SQL document; and on any SQL document, a code lens that applies it as the filter, or reads
that it is active and clears it. *catalog `filter`: input box, or a document*

### Other dialogs

The external-change dialog is `decompile plugin`'s, in its contract. The offer to rebuild a binary
after an interrupted compile is the compile contract's question 4.

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A failed gesture's notification to say what failed and why. *common, Reporting*
2. When a load order leaves plugins unloaded, one notification naming them, beside each row's
   status: my picture of what is loaded would otherwise be wrong. *ADR-0019, invariant 1*
3. Adding and removing `plugins.txt` lines for plugins found or gone to say nothing, the rows being
   the result, with a line in the Output. *update-load-order-file, import plugin, story 5*
4. Every message to name a gesture that exists and a view by its name.

## Deferred

| What | Waits on |
|---|---|
| A plugin's tracked or untracked mark, and its file order decorations | #683, #578 |
| Showing the plugin copies the game does not load | their design |
| `move` from the menu, with its targets: top, bottom, priority N | the catalog's planned Options |
| `highlight origin`, `open details` on a plugin's mod | their design |
| `repair`, `validate`, sort rules, `apply suggested sort`, `rename`, `relink source`, `remove source` | their design |
| `create` record inside a container, `renumber` a plugin | the catalog's planned Options |
| Editing a plugin's header | the catalog's planned `edit field` |

## Test seam

- **The view, given an instance value and mEdit's answers:** the rows at every level, each row's
  parts, the order, and the states, with no VS Code UI and no disk.
- **A gesture's entry:** given the right-clicked row, the focused row and the selection, the
  Argument the command receives.
- **A drop:** given what is dragged and the target, the move's Argument and target, or the refusal.
- **The pickers and prompts:** their items, prefill, refusals, and what Esc yields.
- **Menus and keys:** the placement above, checked against the extension manifest.

