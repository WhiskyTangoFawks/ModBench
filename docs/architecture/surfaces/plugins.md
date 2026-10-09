# Plugins

The Plugins surface shows the plugin order and, beneath each plugin, its records. It is one tree over two templates: its plugin rows follow MO2's plugin list ([ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md)), and the records beneath them follow xEdit's navigator ([ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md)). Where it departs, [mo2.md](../../out-of-scope/mo2.md) and [xedit.md](../../out-of-scope/xedit.md) say why. Its gestures are in [commands.md](../commands.md) under Plugin and Record, `track` under Mod, and Every view. What every view shares is in [common.md](common.md).

Each story cites its source. A story with no source is owned here.

## The view

A native tree view, `modbench.pluginListTree`, third in the `modbench` container and open by default (commands.md, Where surfaces live). It has Collapse All (Chrome). Its plugin rows need only the instance value. What a row holds beneath it needs mEdit, and no view has a mode for mEdit's absence ([ADR-0002](../../adr/0002-mod-management-and-editing-are-one-tool.md)).

The view's description shows the name filter's term and the record filter's source, never its SQL, while each is active: `"arm" · records: armor.sql`.

## The tree

As a user, I want:

1. One row for each line of the active profile's `plugins.txt`, in its order. Source: MO2
2. The plugins the game loads with no line at the losing end, before every line. Source: MO2; ADR-0013
3. An overridden plugin, and a plugin in a disabled mod, not to be a row. Each stays indexed. Source: MO2; ADR-0012
4. A disabled plugin to show no expander, because it is not active. Source: ADR-0012
5. Beneath a plugin, one group for each record type it holds, named as xEdit names it ("Activator"), sorted by name, the worldspaces and cells among the rest. Source: xEdit sorts its navigator by name
6. Beneath a group, its records, in FormID order. A container record holds its children directly, as xEdit folds a record's child group into the record: a worldspace holds its persistent cell and its blocks, a block its sub-blocks, a sub-block its cells, a cell its persistent and temporary child records, its landscape and navmeshes among the temporary ones, a quest its dialog topics, dialog branches and scenes, and a dialog topic its responses. Interior cells sit in blocks and sub-blocks as exterior ones do. Source: xEdit
7. A row with nothing beneath it to show no expander, and an empty group of a cell's child records not to be a row. Source: xEdit
8. Every record at once, with no paging: xEdit shows the full list, and VS Code renders only what is on screen.
9. Every row collapsed each time the extension activates, so the view opens clean. Source: as in Mods

## A row

### Plugin

| Part | What it shows | Source |
|---|---|---|
| Label | the plugin's file name | MO2 |
| Check box | checked when its line is enabled | MO2 |
| Description | the status words below, left out when the plugin has none | common, A view, story 3 |
| Icon | the status below; none when the plugin has no status | common, A view, story 3 |
| Tooltip | the file name, its origin (the mod, Overwrite or the game folder), "read-only" when its records cannot be edited, and a line for each status | ruling |
| Badge | while collapsed, the badges of the records beneath it (common.md story 11) | VS Code's source control badges |
| Identity | the row's kind and the plugin, as (origin, filename) | ADR-0012 |

A plugin's statuses follow. The first that holds, in this order, sets the icon:

| Status | When | Icon | Words |
|---|---|---|---|
| Failed to read | mEdit could not read it | `$(error)` red | failed to read |
| Master issues | it is active, and a master in its header is not (xedit.md, divergence 28); once the snapshot is indexed | `$(error)` red | 1 master issue, N master issues |
| Unreadable records | a record could not be read into its document | `$(error)` red | unreadable records |
| Plugin source unreadable | it is tracked, and its plugin source is missing or cannot be read | `$(warning)` yellow | plugin source unreadable |
| Changed outside Modbench | it is tracked, and its bytes differ from what Modbench last wrote, or either cannot be read | `$(warning)` yellow | changed outside Modbench |
| Malformed | its bytes depart from what the Creation Kit writes | `$(warning)` yellow | malformed |

- A master issue never disables the plugin or cascades to its dependants. The check box stays as I set it. Source: xedit.md, divergence 28
- Before the snapshot is indexed, a plugin shows no master status. That means not yet checked, not no issues.
- A later snapshot keeps the last statuses until the new ones land.
- A plugin that failed to read stays failed until its bytes change or I refresh.
- A malformed plugin's reasons are also in the Problems panel, on the plugin file. Source: commands.md, Surfaces and their templates
- A plugin that changed outside Modbench is also a warning in the Problems panel, on the plugin file, while its bytes differ from what Modbench last wrote. Source: ADR-0003
- A plugin whose plugin source is unreadable shows the records of its plugin file, read-only, until decompile writes its source. Source: ruling

### A plugin the game loads with no line

| Part | What it shows | Source |
|---|---|---|
| Label | the file name, greyed | MO2 |
| Check box | none: VS Code has no check box that cannot be changed, so a lock stands in | |
| Icon | `$(lock)` | |
| Tooltip | "This plugin can't be disabled or moved (enforced by the game)." | MO2's wording |

A `plugins.txt` line that names one is not a second row.

### Record-type group

| Part | What it shows | Source |
|---|---|---|
| Label | the type's name, as xEdit names it | xEdit |
| Description | how many records it holds | xEdit's child count |
| Icon | `$(error)` red when a record beneath it could not be read; none otherwise | |
| Badge | while collapsed, the badges of the records beneath it (common.md story 11) | VS Code's source control badges |

### Record

| Part | What it shows | Source |
|---|---|---|
| Label | the EditorID, or the FormKey when it has none | xEdit |
| Description | the FormKey | xEdit; CONTEXT.md, FormKey |
| Icon | `$(error)` red when it, or a record beneath it, could not be read; none otherwise | |
| Tooltip | its name, when it has one, and the reason it could not be read | xEdit's third column |
| Badge | `M` modified and `A` added, in git's colours, while its plugin source has working-tree changes | ADR-0007; VS Code's source control badges |
| Identity | the row's kind, the plugin as (origin, filename), and the FormKey | ADR-0012 |

A block and a sub-block take xEdit's labels, "Block x, y" and "Sub-Block x, y". An exterior cell without an EditorID takes its grid position. A placed reference without an EditorID takes its base record's. Source: xEdit

### Rows that stand in for records

| Row | When | What it shows |
|---|---|---|
| Still indexing | mEdit does not hold the plugin yet | "Still indexing…", `$(loading~spin)` |
| Error | reading what the row holds failed | common, States, story 2 |

## Order and view state

As a user, I want:

1. Losing at the top until I choose otherwise, and a title-bar toggle that flips the plugin rows. The plugins the game loads with no line stay at the losing end. The groups and records beneath keep their order. Source: common, A view, story 7; MO2's priority sort
2. The name filter to match plugin rows. Source: common, The name filter
3. The record filter to narrow the records to the FormKeys a SQL query returns. Its title-bar slot becomes a clear icon while it is active. It is its own filter, beside the name filter. It narrows the groups' counts too, and applies again after every change to the index. It never narrows the Editor or Referenced By. Source: catalog `filter` under Record; Chrome
4. A plugin with no record left under the record filter hidden while the record filter is active. A later snapshot keeps the rows the record filter hides until the new ones land.

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no `plugins.txt` lines, and no plugin the game loads without one, a message saying so, in the view's message line.
2. While mEdit starts and indexes, the view's progress bar under its title, and every plugin row already there. A row whose plugin is not indexed yet expands to "Still indexing…", never to an error. No notification.
3. While mEdit is unreachable, the rows and their statuses to stay. A row expands to the error row with the reason, and the status bar says mEdit is down. The tree never changes shape. Source: ADR-0002
4. When another window holds the instance's index, every row to expand to the error row naming that, never to "Still indexing…" for ever. Source: Never silently wrong
5. When the record filter matches nothing, a message saying so, naming its source. Source: common, The name filter, story 6
6. When indexing the snapshot fails, the view's message line to name the failure, with one line in the Output. A row whose plugin was not reached expands to the error row naming the failure, never to "Still indexing…" for ever. The plugins read before the failure keep their records, and the next change to the instance tries again.
7. When the record filter cannot apply again after a change to the index, the filter cleared and every record shown, with a notification naming its source and the database's reason. Source: Never silently wrong

## Menus and keys

The menus follow VS Code's groups: open, change, create, source control, copy, then destroy.

| Where | Items, in order |
|---|---|
| Title bar | 1: filter, or clear filter while active. 2: sort direction. 3: filter records, or clear the record filter while active. 4: create plugin. Collapse All last. |
| Plugin menu | reveal · enable or disable · rename… (tracked) · create record… · track (in a mod with no repository) · decompile (in a tracked mod) · compile (tracked) · copy value |
| Plugin the game loads with no line | reveal · copy value |
| Record-type group menu | create record…, except on a group of a type the game cannot create |
| Record menu, on every record row, worldspaces, cells and placed references included | open to the side · create record… (on a container record) · copy… · copy value · delete |
| Check box | enable or disable |
| Keys | Space: enable or disable. Enter: open, as a click does. F2: rename a tracked plugin. Delete: delete records. Ctrl+C: copy value. |

As a user, I want:

1. Each menu item to act on the row I right-clicked, or on the whole selection, as the gesture's Argument in the catalog says. Source: catalog Argument
2. A click on a record to open it in the record panel, and a click on an enabled plugin row to open its header, which is a record. A click on a disabled plugin row only selects it. Source: catalog `open`
3. Enable or disable over a mixed selection to behave as in Mods (Menus and keys, story 2). Source: mods.md
4. The gestures that edit a plugin's records absent on an untracked plugin and on a plugin whose plugin source is unreadable: create record and delete, and the plugin as a copy destination. Track or decompile is on its row. Source: No dead entries
5. Copy value to copy each selected record as `EditorID [FormKey]` and each selected plugin as its file name. Source: catalog `copy value`; [editor-fields.md](editor-fields.md)

## Drag and drop

As a user, I want:

1. To drag plugin rows, one or several. They move as one block in their `plugins.txt` order.
2. A drop on a plugin row to place the block directly above it, as shown; on a plugin the game loads with no line, at the losing end of `plugins.txt`; below the last row, at the bottom of the view, as shown.
3. A drop that would put a master after a plugin that depends on it, or a blueprint plugin before a plugin that is not one, refused, naming the plugin and the master. A drop whose masters mEdit cannot say yet lands; the Master issues row flags it once mEdit reads the plugin. Source: xedit.md, divergence 28
4. A drop where the block cannot go to change nothing and say nothing: on a record, a group, or a row being dragged. Source: mods.md, Drag and drop, story 5
5. Records, groups and the rows of plugins the game loads with no line not to drag, and nothing from outside the view to drop here. Source: xedit.md: Drag a record onto a reference field

## Pickers, prompts and confirmations

### Create plugin

As a user, I want:

1. A prompt for the name. It refuses an empty name, a name that does not end `.esp`, `.esm` or `.esl`, and `.esl` when the game has no light plugins.
2. Then a pick of where the plugin lives: the enabled mods first, then Overwrite. Source: catalog `create`, place Option
3. A place that already holds a plugin of that name left out of the pick. The same name in another place is not checked. Source: No dead entries
4. Esc at either step to create nothing. Source: Esc changes nothing
5. The new plugin to appear at the winning end of the list, disabled. Source: catalog `plugin sync`
6. The new plugin empty: a header with no records and no masters, flagged by its extension: `.esm` a master, `.esl` a light plugin.
7. A plugin created in a tracked mod to land with its plugin source, as working-tree changes I can review. Source: CONTEXT.md, Tracked mod

### Track

As a user, I want:

1. No prompt. While it runs, the view's message line names the mod and the phase. Source: catalog `track`
2. The repository to track `plugin-source/` and `.gitignore`, and nothing else. Source: ADR-0006
3. One commit, `Track <mod>`, holding the source of every plugin the mod provides.
4. Each file's line endings kept as written.
5. A track that refuses any plugin to write nothing and leave no repository, naming each refused plugin and why.

### Decompile

As a user, I want one confirmation for the selection, naming the plugins and saying that decompile replaces their source in the working tree from their bytes. Source: catalog `decompile`; Confirm what destroys

### Compile

As a user, I want:

1. `compile` to build from the working tree, without asking: a tracked plugin's plugin source is the truth, and compile builds the plugin from it.
2. The view's progress bar while it runs, and a notification when it lands, pointing at the Problems panel when it left diagnostics. The diagnostics sit on the plugin source files.
3. From the palette with no plugin, a pick of the tracked plugins. Source: No dead entries
4. A light plugin whose records fall outside the light range refused, naming the records and the remedies: clear the light flag, rename the plugin off `.esl`, or change the records' FormIDs.
5. An interrupted compile to leave the old binary or the new one, and neither to read as changed outside Modbench. A localized plugin can be left with its strings written without its binary. Compiling again fixes it. This is an exception to A failed gesture writes nothing.
6. A plugin whose plugin source is unreadable refused, naming it and pointing at decompile. Source: Never silently wrong
7. `compile` to save the plugin's unsaved plugin source first, without asking, as Run Build Task saves before it builds, so the plugin is built from what I see. A file VS Code does not save refuses compile, naming it. Source: VS Code's save before run; ADR-0001; Never silently wrong

### Rename plugin

As a user, I want:

1. A prompt filled with the current name. Esc, an empty name or the same name renames nothing. It refuses what Create plugin, stories 1 and 3 refuse, compared without case. The extension may change. Source: Windows and Linux alike
2. The plugin to keep its place in plugin order and its enabled state in every profile. Its plugin source and what Modbench last wrote follow it. Source: Never silently wrong
3. The files in its mod named for it to follow it: its strings, its archives and its `.ini`. Source: Never silently wrong
4. One confirmation when a plugin in the instance lists it as a master, naming each one and saying it keeps the old name and will show Master issues. Nothing asked otherwise. This is an exception to Confirm what destroys: the rename breaks those plugins' master.
5. The plugin source renamed first, as working-tree changes I can review. Then the file, the files named for it and its lines, in one write. A rename that failed on that write to say so, naming the plugin. Git shows the source rename, and reverting it is the recovery. The file reads as a plugin whose plugin source is unreadable until then. This is an exception to A failed gesture writes nothing.

### Move

As a user, I want:

1. From the palette, the selected plugins to move as one block to a place I pick: directly above a plugin row outside the selection, in the order the view shows them, or "Bottom of the view". The block lands as a drop there lands. Source: catalog `move`, target Option; Drag and drop, story 2
2. A pick that a drop there would refuse refused the same way. Source: Drag and drop, story 3
3. Esc to move nothing. Source: Esc changes nothing

### Create record

As a user, I want:

1. On a group, a new record of that type with no prompt, and on a plugin a pick of the record type first. The pick lists the types the game can create. The new record is selected and opens in the record panel. Source: catalog `create` under Record, record type Option; xEdit selects what it adds
2. The new record to take the first FormKey at or above the plugin header's Next Object ID that no record uses, and the counter to move past it, so a FormKey a deleted record held is never given again. No EditorID, as xEdit adds one. Source: xEdit; Mutagen's data
3. When no FormKey at or above the Next Object ID is free, a refusal saying so, naming clearing the light flag as the remedy on a light plugin. Source: Mutagen's data; Never silently wrong
4. No create record on a group of a type the game cannot create. Source: No dead entries
5. On a container record, a pick of the types it can hold. The pick is skipped when it can hold one type. The new record lands inside the container. Source: xEdit; Mutagen's data
6. A placed reference created on a cell to land in its temporary child records, or in its persistent ones when the cell is persistent. In an exterior cell's temporary child records, it starts at the centre of the cell. Source: xEdit
7. A cell created on a plugin or on the Cell group to be an interior cell. It takes its block and sub-block from its FormID. Source: xEdit
8. On a worldspace, a prompt for the new cell's grid position as `x, y`. The prompt refuses anything but two whole numbers. The new cell lands in the block and sub-block its position falls in. Source: xEdit
9. A position where the worldspace already has a cell, in this plugin or a master, refused, naming the cell. When a master holds the cell, the refusal points at copy as override. Source: xedit.md, divergence 27

### Copy

As a user, I want:

1. A pick of the mode, then a pick of the destination: the plugins I can edit, each with its load index, or `(not active)`. A destination that already holds a copy asks whether to replace it. Esc on either copies nothing. Source: catalog `copy`
2. A copy as new to take the next free FormKey. A reference to itself follows it.
3. A copy as override into a plugin that loads before a master the copy needs, its origin or a plugin holding a record it references, refused: that is an underride. A plugin that is not active is judged at its line in `plugins.txt`, and one with no line is not judged. A cell or a worldspace copied as new refused.
4. A container the destination lacks copied in as an override, in every mode. Where the game lets it be a Partial Form, it is one, so it carries only its children and overrides none of the container's own fields. Source: xEdit; editor-fields.md, Partial Form; ruling
5. A copy, in either mode, to copy each record without its child records. To copy a child record too, I select it. Source: xEdit; commands.md, An all variant is select all, then the gesture

### Delete

As a user, I want one confirmation listing everything selected, saying the records leave their plugin source as working-tree changes I can review. A deleted record's referrers are left as they are, and compile reports them. Source: catalog `delete`; Confirm what destroys

### Record filter

As a user, I want a pick of the workspace's `.sql` files, then "New filter…", which opens an untitled SQL document; and on any SQL document, a code lens that applies it as the filter, or reads that it is active and clears it. A query that returns no FormKey column is refused, and one that cannot run is refused with the database's reason. Source: catalog `filter`, query Option

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. When mEdit cannot read active plugins, one notification naming them, beside each row's status: my picture of my records would otherwise be wrong. Source: ADR-0019
2. Adding and removing `plugins.txt` lines for plugins found or gone to say nothing, the rows being the result, with a line in the Output. When a folder cannot be listed, or the game folder is not found, `plugins.txt` untouched, and the reason in the view's message line and the Output.
3. Every message to name a gesture that exists and a view by its name.
4. A notification for each tracked mod whose plugins changed outside Modbench, naming the mod and the plugins. It offers nothing to do. It comes once in a session for each new state of a plugin's bytes. Source: ADR-0003
5. A warning, once in a session, for each plugin whose plugin source is unreadable, naming it and pointing at decompile. Story 4's notification leaves that plugin out.

## Test seam

- The view, given an instance value and mEdit's answers: the rows at every level, each row's parts, the order, and the states, with no VS Code UI and no disk.
- A gesture's entry: given the right-clicked row, the focused row and the selection, the Argument the command receives.
- A drop: given what is dragged and the target, the move's Argument and target, or the refusal.
- The pickers and prompts: their items, prefill, refusals, and what Esc yields.
- Menus and keys: the placement above, checked against the extension manifest.

