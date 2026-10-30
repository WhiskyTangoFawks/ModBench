# Plugins

The Plugins surface shows the plugin order and, beneath each plugin, its records. It is one tree over two templates: its plugin rows follow MO2's plugin list ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)), and the records beneath them follow xEdit's navigator ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md)). Where it departs, [mo2.md](../out-of-scope/mo2.md) and [xedit.md](../out-of-scope/xedit.md) say why. Its gestures are in [commands.md](commands.md) under Plugin and Record, `decompile and commit` and `build` under Mod, and Every view. What every view shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## The view

A native tree view (commands.md, Where surfaces live). Its plugin rows need only the instance value. What a row holds beneath it needs mEdit, and no view has a mode for mEdit's absence ([ADR-0002](../adr/0002-mod-management-and-editing-are-one-tool.md)).

The view's description names each active filter: the name filter's term, and the record filter's document.

## The tree

As a user, I want:

1. One row for each name in the active profile's `plugins.txt`, in its order, and one for each plugin the game loads with no line, each plugin once. Cites: MO2
2. The plugins the game loads with no line at the losing end, before every line. Cites: MO2
3. An overridden plugin, and a plugin in a disabled mod, not to be a row. Each stays indexed. Cites: MO2; ADR-0012
4. A disabled plugin to show no expander, because it is not active. Cites: ADR-0012
5. Beneath a plugin, one group for each record type it holds, named as xEdit names it ("Activator"), sorted by name. Cites: xEdit sorts its navigator by name
6. Beneath a group, its records, in FormID order. A container record holds its child records directly, as xEdit folds a record's child group into the record. Cites: xEdit
7. A row with nothing beneath it to show no expander, and an empty group of a cell's child records not to be a row. Cites: xEdit
8. Every record at once, with no paging, as xEdit shows the full list.
9. Every row collapsed when the window opens, so the view opens clean. Cites: common, A view, story 4
10. A clone or a checkout to keep the plugin order of each mod I have not restored yet. Cites: mo2.md, divergence 17; ADR-0022
11. My selection and what I expanded to survive a change on disk. Cites: common, A view, story 2

## A row

### Plugin

| Part | What it shows | Cites |
|---|---|---|
| Label | the plugin's file name | MO2 |
| Check box | checked when its line is enabled | MO2 |
| Description | the status words below, left out when the plugin has none | common, A view, story 3 |
| Icon | the status below; none when the plugin has no status | common, A view, story 3 |
| Tooltip | the file name, its origin (the mod, Overwrite or the game folder), "read-only" when its records cannot be edited, a line for each status, and a line for each entry of Sorting rules, story 1 | ruling |
| Badge | while collapsed, the badges of the records beneath it (common.md story 11) | VS Code's source control badges |

A plugin's statuses follow. The first that holds, in this order, sets the icon:

| Status | When | Icon | Words |
|---|---|---|---|
| Not restored | a mod's manifest names it, and I have not restored it | `$(warning)` yellow | not restored |
| Failed to read | mEdit could not read it | `$(error)` red | failed to read |
| Sorting errors | it is active, and Sorting rules shows an Error for it; once the snapshot is indexed | `$(error)` red | 1 error, N errors |
| Unreadable records | a record could not be read into its document | `$(error)` red | unreadable records |
| Plugin source unreadable | it is a compiled plugin, and its plugin source is missing or cannot be read | `$(warning)` yellow | plugin source unreadable |
| Changed outside Modbench | it is a compiled plugin, and its bytes differ from what Modbench last wrote, or either cannot be read | `$(warning)` yellow | changed outside Modbench |
| Malformed | its bytes depart from what the Creation Kit writes | `$(warning)` yellow | malformed |
| Sorting warnings | it is active, and Sorting rules shows a Warning for it; once the snapshot is indexed | `$(warning)` yellow | 1 warning, N warnings |

- A broken sorting rule never disables the plugin, cascades to its dependants or moves a plugin. The check box and the order stay as I set them. Cites: xedit.md, divergence 28; ADR-0026
- Before the snapshot is indexed, a plugin shows no sorting status. That means not yet checked, not no broken rules.
- A later snapshot keeps the last statuses until the new ones land.
- A plugin that failed to read stays failed until its bytes change or I refresh. A failure that names another file clears once that file reads. Cites: ADR-0003
- A malformed plugin's reasons are also in the Problems panel, on the plugin file. Cites: common.md, Reporting
- A plugin that changed outside Modbench is also a warning in the Problems panel, on the plugin file, while its bytes differ from what Modbench last wrote. Cites: ADR-0003
- A plugin that holds one FormKey in two groups fails to read, as xEdit refuses a duplicate FormID. The reason is also an error in the Problems panel, on the plugin file. Cites: ruling; xEdit
- A plugin whose plugin source is unreadable on disk shows the records of its plugin file, read-only, until decompile writes its source. It is also a warning in the Problems panel, on the plugin file, pointing at decompile. An unsaved document that does not read is a failed later read, as [common.md](common.md), States, story 6 says. Cites: ruling

### A plugin the game loads with no line

| Part | What it shows | Cites |
|---|---|---|
| Label | the file name, greyed | MO2 |
| Check box | none: the lock shows it cannot be disabled | |
| Icon | `$(lock)` | |
| Tooltip | "This plugin can't be disabled or moved (enforced by the game)." | MO2's wording |

### Record-type group

| Part | What it shows | Cites |
|---|---|---|
| Label | the type's name, as xEdit names it | xEdit |
| Description | how many records it holds | xEdit's child count |
| Icon | `$(error)` red when a record beneath it could not be read; none otherwise | |
| Badge | while collapsed, the badges of the records beneath it (common.md story 11) | VS Code's source control badges |

### Record

| Part | What it shows | Cites |
|---|---|---|
| Label | as xEdit's navigator labels it: the EditorID, or what xEdit shows without one | xEdit |
| Description | the FormKey | xEdit; GLOSSARY.md, FormKey |
| Icon | `$(error)` red when it, or a record beneath it, could not be read; none otherwise | |
| Tooltip | its name, when it has one, and the reason it could not be read | xEdit's third column |
| Badge | `M` modified and `A` added, in git's colours, while its plugin source has working-tree changes | ADR-0007; VS Code's source control badges |

A block and a sub-block take xEdit's labels too. Cites: xEdit

### Rows that stand in for records

| Row | When | What it shows |
|---|---|---|
| Still indexing | mEdit does not hold the plugin yet | "Still indexing…", `$(loading~spin)` |
| Error | reading what the row holds failed | common, States, story 2 |

## Order and view state

As a user, I want:

1. Losing at the top until I choose otherwise, and a title-bar toggle that flips the plugin rows. The plugins the game loads with no line stay at the losing end. Records have no winning end, so they keep their order. Cites: common, A view, story 7; MO2's priority sort
2. The name filter to match plugin rows. Cites: common, The name filter
3. The record filter to narrow the records to the FormKeys a SQL query returns, the groups' counts with them, and to apply again after every change to the record index. Cites: catalog `filter` under Record; Chrome
4. A plugin with no record left under the record filter hidden while the record filter is active. A later snapshot keeps the rows the record filter hides until the new ones land.

## Sorting rules

Modbench judges the plugin order I have against the game's sorting rules and LOOT's ([ADR-0026](../adr/0026-modbench-checks-the-plugin-order-against-loots-metadata-and-never-sorts-it.md)). LOOT's come from the instance's masterlist and userlist. Each kind of sorting rule has a level, and so does each LOOT message and LOOT's cleaning data:

| Level | A sorting rule broken, or a LOOT message or cleaning data that applies |
|---|---|
| Error | a master loads after a plugin that lists it · a blueprint plugin loads before a plugin that is not one · a master is missing or not active · a requirement is missing · an incompatibility is present · a LOOT error message |
| Warning | a plugin with the master flag is listed after a plugin without it, so the game loads it earlier than the view shows · a plugin loads before a plugin its sorting rule says it loads after · a LOOT warning message |
| Info | a LOOT group loads before a LOOT group it names · LOOT's cleaning data says the plugin is dirty · a LOOT say message |

As a user, I want:

1. Each broken sorting rule, LOOT message and cleaning data that applies to show at its level. Cites: LOOT
2. The game's sorting rules always to apply. Cites: ADR-0026
3. A requirement and an incompatibility to count a plugin present as LOOT does. Cites: LOOT; ADR-0026
4. Each in the Problems panel, on the plugin file, at its level, in LOOT's words. One the userlist states is also on its line in the userlist. Info sets no row icon. Cites: common.md, Reporting
5. Apply suggested move offered for a broken rule a move keeps, when that move breaks no other rule at Error: on the plugin row, and as a code action on its line in the userlist. Modbench moves a plugin only for a gesture I start. Cites: ADR-0026; No dead entries
6. To disagree with a masterlist rule by editing the masterlist in the instance. Git shows my edit, and update masterlist shows it undone in its diff. Cites: ADR-0026
7. The userlist and the masterlist to open as text in VS Code, as any file in the instance. Cites: loot.md, divergence 5
8. A sorting rule file that does not read named in the view's message line, and in the Problems panel on its line. The rules that read still apply. A condition Modbench cannot evaluate is a Warning on its line, never skipped. Cites: Never silently wrong

## The highlight

A selection here or in Mods highlights the rows related to it. The highlight marks a row's label as VS Code's find marks a match, and shows where the related rows sit in the plugin order and the mod order. As a user, I want:

1. A selection of mods or Overwrite to highlight every plugin they hold. For an overridden plugin, it highlights the row of the plugin that overrides it. A disabled mod highlights nothing. Cites: MO2
2. A selected separator to highlight what the mods it holds highlight, open or collapsed. Cites: mo2.md, Divergences, 18
3. A selection of plugins to highlight, in Mods, the mod or Overwrite each one comes from. A plugin from the game folder highlights no row in Mods. Cites: MO2; ADR-0012
4. A selection of plugins to highlight their masters here. A plugin mEdit has not read yet highlights no masters. Cites: MO2
5. The highlight to follow the view I last selected in. The selection left in the other view highlights nothing until I select there again. Cites: mo2.md, Divergences, 18
6. Selected rows of any other kind to highlight nothing, so a selection of only those clears the highlight.

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no `plugins.txt` lines, and no plugin the game loads without one, a message saying so, in the view's message line.
2. While mEdit starts and indexes, the view's progress bar under its title, and every plugin row already there. A row whose plugin is not indexed yet expands to "Still indexing…", never to an error.
3. While mEdit is unreachable, the rows and their statuses to stay. A row expands to the error row with the reason. The tree never changes shape. Cites: ADR-0002
4. When another window holds the instance's record index, every row to expand to the error row naming that, and saying that refresh takes the record index once that window closes. Never "Still indexing…" for ever. Cites: Never silently wrong; ADR-0003
5. When the record filter matches nothing, a message saying so, naming its document. Cites: common, The name filter, story 6
6. When indexing the snapshot fails, the view's message line to name the failure. A row whose plugin was not reached expands to the error row naming the failure, never to "Still indexing…" for ever. The plugins read before the failure keep their records, and the next change to the instance tries again.
7. When the record filter cannot apply again after a change to the record index, the filter cleared and every record shown, and the notification to name its document and the database's reason. Cites: common.md, Reporting
8. With no masterlist in the instance, the view's message line to say so and name update masterlist. The game's sorting rules and the userlist's still apply. Cites: Never silently wrong

## Menus and keys

The menus follow VS Code's groups: open, change, create, source control, copy, then destroy.

| Where | Items, in order |
|---|---|
| Title bar | 1: filter, or clear filter while active. 2: sort direction. 3: filter records, or clear the record filter while active. 4: create plugin. Collapse All last. |
| Plugin menu | reveal · enable or disable · apply suggested move (a broken sorting rule a move keeps) · rename… (a compiled plugin) · load after… · create record… · decompile and commit (a mod that is not a source mod) · decompile (in a source mod) · decompile and repair (a malformed plugin) · build (in a source mod) · copy value |
| Plugin the game loads with no line | reveal · copy value |
| Record-type group menu | create record…, except on a group of a type the game cannot create |
| Record menu, on every record row, worldspaces, cells and placed references included | open · referenced by · create record… (on a container record, Menus and keys, story 4) · copy… · copy value · delete (Menus and keys, story 4) |
| Check box | enable or disable |
| Keys | Space: enable or disable. Enter: open, as a click does. F2: rename a compiled plugin. Delete: delete records. Ctrl+C: copy value. |

As a user, I want:

1. Each menu item to act as the gesture's Argument in the catalog says. Cites: commands.md, Argument
2. A click on a record to open it in the record panel, and a click on an enabled plugin row to open its header, which is a record. A click on a disabled plugin row only selects it, which highlights its related rows (The highlight). Cites: catalog `open`
3. Enable or disable over a mixed selection to behave as in Mods (Menus and keys, story 2). Cites: mods.md
4. The gestures that edit a plugin's records absent on a plugin with no plugin source and on a plugin whose plugin source is unreadable: create record and delete, and the plugin as a copy destination. Decompile and commit, or decompile, is on its row. Cites: No dead entries
5. Copy value to copy each selected record as `EditorID [FormKey]` and each selected plugin as its file name. Cites: catalog `copy value`; [editor-fields.md](editor-fields.md)

## Drag and drop

As a user, I want:

1. To drag plugin rows, one or several. They move as one block in their `plugins.txt` order.
2. A drop on a plugin row to place the block directly above it, as shown; on a plugin the game loads with no line, at the losing end of `plugins.txt`; below the last row, at the bottom of the view, as shown.
3. A drop that would newly break a sorting rule at Error refused, naming the rule and its plugins. Any other drop lands, and each rule it breaks shows as broken once mEdit reads the plugin. Cites: ADR-0026; xedit.md, divergence 28
4. A drop where the block cannot go to be refused, saying why: on a record, a group, or a row being dragged. Cites: Refuse, do not repair; mods.md, Drag and drop, story 5
5. Records, groups and the rows of plugins the game loads with no line not to drag, and nothing from outside the view to drop here. Cites: xedit.md: Drag a record onto a reference field

## Pickers, prompts and confirmations

### Create plugin

As a user, I want:

1. A prompt for the name. It refuses an empty name, and a name whose extension the game does not load as a plugin.
2. Then a pick of where the plugin lives: the enabled mods first, then Overwrite. Cites: catalog `create`, Argument
3. A place that already holds a plugin of that name left out of the pick. Cites: No dead entries
4. Esc at either step to create nothing. Cites: Esc changes nothing
5. The new plugin to appear at the winning end of the list, disabled. Cites: catalog `plugin sync`
6. The new plugin empty: a header with no records and no masters, flagged as its extension means.
7. A plugin created in a source mod to land with its plugin source, as working-tree changes I can review. Cites: GLOSSARY.md, Source mod

### Decompile and commit

As a user, I want:

1. No prompt. While it runs, the view's message line names the mod and the phase. Cites: catalog `decompile and commit`
2. The repository to track the plugin source, the mod's assets, the manifest and `.gitignore`, and nothing else. The assets are the mod's files that no package yields with their bytes. Cites: ADR-0007; ADR-0022
3. One commit, `Init <mod>`, holding the source of every plugin the mod provides, the assets and the manifest.
4. Each file's line endings kept as written.
5. A decompile and commit that refuses any plugin to write nothing and leave no repository, naming each refused plugin and why.

### Decompile

As a user, I want one confirmation for the selection only when decompile would replace a change to plugin source that git does not hold, naming those plugins. Cites: catalog `decompile`; Confirm what destroys

### Rename plugin

As a user, I want:

1. A prompt filled with the current name. Esc, an empty name or the same name renames nothing. It refuses what Create plugin, story 1 refuses, and a name another plugin in its place has, compared without case. The extension may change. Cites: Windows and Linux alike; mods.md, Rename mod, story 2
2. The plugin to keep its place in plugin order and its enabled state in every profile. Its plugin source and what Modbench last wrote follow it. Cites: Never silently wrong
3. The files in its mod that the game ties to it by name to follow it. Cites: Never silently wrong
4. The plugin source renamed first, as working-tree changes I can review. Then the file, the files named for it and its lines, in one write. A rename that failed on that write to say so, naming the plugin. Git shows the source rename, and reverting it is the recovery. The file reads as a plugin whose plugin source is unreadable until then.

### Move

As a user, I want:

1. From the palette, the selected plugins to move as one block to a place I pick: directly above a plugin row outside the selection, in the order the view shows them, or "Bottom of the view". The block lands as a drop there lands. Cites: catalog `move`, target Option; Drag and drop, story 2
2. A pick that a drop there would refuse refused the same way. Cites: Drag and drop, story 3
3. Esc to move nothing. Cites: Esc changes nothing

### Load after

As a user, I want:

1. A pick of one or more plugins the selected plugins load after: the active plugins outside the selection, in the order the view shows them. Cites: LOOT, Edit Metadata, Load After
2. The userlist to gain a sorting rule for each selected plugin that it loads after each picked plugin, as LOOT writes it. A rule the userlist holds already writes nothing.
3. Esc to write nothing. Cites: Esc changes nothing

### Apply suggested move

As a user, I want:

1. When one broken rule offers a move, no prompt. When more than one does, a pick of those rules.
2. The plugin to move to the nearest place that keeps the rule: directly below the plugin it must load after, or directly above the plugin it must load before.

### Update masterlist

As a user, I want:

1. No prompt. While it runs, the view's message line says so.
2. One confirmation, only while the masterlist has uncommitted changes, naming them. Cites: Confirm what destroys

### Create record

As a user, I want:

1. On a group, a new record of that type with no prompt, and on a plugin a pick of the record type first. The pick lists the types the game can create. The new record is selected and opens in the record panel. Cites: catalog `create` under Record, record type Option; xEdit selects what it adds
2. The new record to take the first FormKey at or above the plugin header's Next Object ID that no record uses, and the counter to move past it, so a FormKey a deleted record held is never given again. No EditorID, as xEdit adds one. Cites: xEdit; Mutagen's data
3. When no FormKey at or above the Next Object ID is free, a refusal saying so, naming clearing the flag as the remedy on a plugin whose header flag limits its FormIDs. Cites: Mutagen's data; Never silently wrong
4. No create record on a group of a type the game cannot create. Cites: No dead entries
5. On a container record, a pick of the types it can hold. The pick is skipped when it can hold one type. The new record lands inside the container. Cites: xEdit; Mutagen's data
6. A placed reference created on a cell to land in its temporary child records, or in its persistent ones when the cell is persistent. In an exterior cell's temporary child records, it starts at the centre of the cell. Cites: xEdit
7. A cell created on a plugin or on the Cell group to be an interior cell. It takes its block and sub-block from its FormID. Cites: xEdit
8. On a worldspace, a prompt for the new cell's grid position as `x, y`. The prompt refuses anything but two whole numbers. The new cell lands in the block and sub-block its position falls in. Cites: xEdit
9. A position where the worldspace already has a cell, in this plugin or a master, refused, naming the cell. When a master holds the cell, the refusal points at copy as override. Cites: xedit.md, divergence 27

### Copy

As a user, I want:

1. A pick of the mode, then a pick of the destination: the plugins I can edit, each with its load index, or `(not active)`. A destination that already holds a copy asks whether to replace it. Esc on either copies nothing. Cites: catalog `copy`
2. A copy as new to take the next free FormKey. A reference to itself follows it.
3. A copy as override into a plugin that loads before a master the copy needs, its origin or a plugin holding a record it references, refused: that is an underride (commands.md, A compiled plugin is its files). A record xEdit does not copy as new, such as a cell or a worldspace, refused.
4. A container the destination lacks copied in as an override, in every mode. Where the game lets it be a Partial Form, it is one, so it carries only its children and overrides none of the container's own fields. Cites: xedit.md, divergence 30; editor-fields.md, Partial Form
5. A copy, in either mode, to copy each record without its child records. To copy a child record too, I select it. Cites: xEdit; commands.md, An all variant is select all, then the gesture

### Delete

As a user, I want a deleted record's referrers left as they are, and compile to report them. Cites: catalog `delete`; xEdit

### Record filter

As a user, I want a pick of the workspace's `.sql` files, then "New filter…", which opens an untitled SQL document; and on any SQL document, a code lens that applies it as the filter, or reads that it is active and clears it. A query that returns no FormKey column is refused, and one that cannot run is refused with the database's reason. Cites: catalog `filter`, query Option

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A plugin mEdit cannot read to be an error in the Problems panel, on the plugin file, naming why, while it holds. Cites: common.md, Reporting
2. Adding and removing `plugins.txt` lines for plugins found or gone to say nothing, the rows being the result. When a folder cannot be listed, or the game folder is not found, `plugins.txt` untouched.
3. Every message to name a gesture that exists and a view by its name.
