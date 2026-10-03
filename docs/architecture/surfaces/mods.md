# Mods

The Mods surface shows the active profile's mod order: its mods, grouped by separators, and the Overwrite folder. Each mod and Overwrite opens into its files, and each file shows whether the game gets it. Its template is MO2's mod list ([ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs, [mo2.md](../../out-of-scope/mo2.md) says why. Its gestures are in [commands.md](../commands.md) under Mod and Separator. What every view shares is in [common.md](common.md). [mods-conflicts.md](mods-conflicts.md) holds the conflict table, which opens from a mod's row in an editor tab.

Each story cites its source. A story with no source is owned here.

## The view

A native tree view, `modbench.modList`, second in the `modbench` container and open by default (commands.md, Where surfaces live). Separators hold the mods they group, and a mod or Overwrite holds its files, so it has Collapse All (Chrome).

The view's description shows how many mods are enabled out of how many are listed, counting the whole list even while a filter is active, then the filter's term: `12 / 30 · "arm"`. *MO2's active-mod counter*

## The tree

As a user, I want:

1. One row for each line of the active profile's `modlist.txt` that names a mod or a separator. A line MO2 marks unmanaged (`*`) is not a row. *MO2, which hides unmanaged mods by default*
2. Each separator to hold the mods between it and the next separator toward the winning end, whichever way the list is sorted. *CONTEXT.md, Mod separator; MO2*
3. The mods on the losing side of the first separator to be ungrouped: top-level rows at the losing end of the view. *MO2*
4. The Overwrite row pinned at the winning end, outside every separator: last when losing is at the top, first when winning is. *MO2: Overwrite wins over every mod*
5. Separators, mods, Overwrite and folders collapsed each time the extension activates, so the view opens clean. What I expand stays expanded until then.
6. A separator with no mods to show no expander. *VS Code*
7. A mod or Overwrite to open into its files as a folder tree: folders first, then files, each by name. A disabled mod opens too. One with no files shows no expander. *VS Code's Explorer*
8. The name of a file the game does not get to be greyed. The game does not get a file when another copy wins its path, when it is excluded, or when its mod is disabled. *MO2*
9. Only the files Modbench deploys from the mod to show: not `meta.ini`, the repository or plugin source. An excluded file shows its full name, `.mohidden` included. A folder with that suffix is excluded with everything in it, and is greyed. *MO2*
10. The same grey and badges on the same files in VS Code's Explorer. *VS Code*

## A row

### Mod

| Part | What it shows | Source |
|---|---|---|
| Label | the mod's name | MO2 |
| Check box | checked when the mod is enabled | MO2 |
| Description | the `meta.ini` version | MO2 |
| Icon | `$(package)` | |
| Indicators | a badge at the right edge, and a colour on the label, for each indicator that holds ([Indicators](#indicators)) | MO2's Conflicts and Flags columns |
| Tooltip | name, version, Nexus mod ID and installation file, each only when known | MO2's columns |
| Identity | the row's kind and the mod's name, so selection and expansion survive a change on disk. A mod and a separator can share a name. | |

### Separator

| Part | What it shows | Source |
|---|---|---|
| Label | the separator's name, without MO2's `_separator` suffix | MO2 |
| Check box, icon, description | none | MO2 draws a separator as a heading |
| Identity | the row's kind and the separator's name | |

### Overwrite

| Part | What it shows | Source |
|---|---|---|
| Label | Overwrite | MO2 |
| Description | the number of files it holds, left out when it holds none | |
| Icon | `$(folder)`, tinted when it holds files, with no badge | |
| Tooltip | what Overwrite is: the files tools wrote while MO2 ran them, which win over every mod | MO2 |

Overwrite is always a row, even when it holds nothing. It is not a mod: it has no check box and cannot be dragged. *MO2*

### File and folder

| Part | What it shows | Source |
|---|---|---|
| Label | the file's or folder's name | VS Code's Explorer |
| Icon | the file icon theme's icon | VS Code's Explorer |
| Colour | greyed when the game does not get the file (The tree, story 8) | |
| Tooltip | the path in its mod | |
| Identity | the mod or Overwrite, and the path in it | |

## Indicators

A mod row carries an indicator for each status that holds. A disabled mod carries none. Each indicator has a badge and a colour, and my settings switch each on or off. Each colour is a theme colour Modbench contributes. *MO2's Conflicts and Flags columns; editor-conflicts, The colours, story 1*

| Indicator | Holds when | Badge | Colour |
|---|---|---|---|
| Overwrites loose files | a file of the mod wins over another copy | off | off |
| Overwritten loose files | a file of the mod loses to another copy, and the mod is not Redundant | on | off |
| Redundant | the mod has a file the game could get, and every such file loses to another copy | on | off |
| Contains excluded files | the mod has an excluded file | off | off |

The Badge and Colour columns are the defaults. The grey of a file the game does not get is a setting too, on by default. A mod that wins some files and loses others carries both badges. Each indicator's tooltip is its name in this table. *mo2.md, divergence 12*

## Order and view state

As a user, I want:

1. Losing at the top until I choose otherwise, and a title-bar toggle that flips the whole tree, separators and the mods inside them. *MO2's priority sort; common, A view, story 7*
2. The name filter to match the name of any row: a separator, a mod, a folder or a file. A row whose name matches shows all its children; otherwise it shows only its matching children, expanded, and one with none is not shown. Overwrite stays, and does not count as a match; its files follow the same rule. *common, The name filter*
3. A toggle in the filter box to show the matches as a flat list, with no separators. Mods still open to their matching files. It returns to grouped whenever the filter clears.

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no mods and no separators, the view's message line to say so and to name install and create empty mod, in the title bar's overflow.

## Menus and keys

The row menus follow VS Code's groups: open, change, create, source control, copy, then destroy.

| Where | Items, in order |
|---|---|
| Title bar | 1: filter, or clear filter while active. 2: sort direction. Overflow: install… · create empty mod. Collapse All last. |
| Mod menu | open folder · open conflicts (the mod has a file order conflict) · view on Nexus (the mod has a Nexus mod ID) · enable or disable · move… · add separator · create empty mod · install… · track (the mod has no repository and holds a plugin) · copy value · uninstall |
| Separator menu | move… · add separator · rename… · copy value · delete |
| Overwrite menu | open folder |
| File menu | open folder · compare file (a file in a file order conflict, not the winning copy) · go to mod (a file in a file order conflict) · exclude or include · copy value |
| Folder menu | open folder · copy value |
| Check box | enable or disable |
| Keys | Space: enable or disable. Delete: uninstall, or delete a separator. F2: rename a separator. Ctrl+C: copy value. |

As a user, I want:

1. Each menu item to act on the row I right-clicked, or on the whole selection, as the gesture's Argument in the catalog says. *catalog Argument*
2. Enable or disable, over a selection that mixes enabled and disabled mods, to apply the right-clicked row's direction to every mod. Space takes the focused row's direction. A mod already in that state is left alone. *MO2; Doing nothing is not an error*
3. Delete to act on the selected rows of the focused row's kind: uninstall for mods, delete for separators.
4. A click or double click on a separator, a mod, Overwrite or a folder to do nothing but select it; its expander opens it. A click on a file opens it as a preview editor. *VS Code's Explorer*
5. Copy value to copy each selected mod's or separator's name, and each selected file's or folder's path in its mod. *catalog `copy value`*
6. Go to mod to select, in this tree, the row it names. *catalog `go to mod`; MO2's Go to...*
7. Exclude or include, over a selection that mixes both, to apply the right-clicked row's direction to every file, as enable or disable does. *story 2*
8. Space, Delete and F2 to do nothing on a file or folder: the tree shows files, and the Explorer manages them. This is an exception to common, A view, story 5.

## Drag and drop

As a user, I want:

1. To drag mods and separators, one or several. A separator brings every mod it holds. *MO2*
2. A drop of mods on a mod to place them directly above it, as shown, in that mod's separator.
3. A drop on a separator to make the mods I dragged its first mods, as shown. A separator dropped on a separator lands directly above it, as shown.
4. A drop below the last row to place what I dragged at the bottom of the view, as shown, above Overwrite when Overwrite is last.
5. A drop where what I dragged cannot go to change nothing and say nothing: on Overwrite, on a row I am dragging, inside a separator I am dragging, or a separator on a mod. *MO2 refuses a separator on a mod; Doing nothing is not an error*
6. Nothing from outside the view to drop here: no archive, folder, file or downloaded file. *mo2.md*
7. Files and folders not to drag, and nothing to drop on them.

## Pickers, prompts and confirmations

### Move

As a user, I want:

1. For mods, a pick of the places to move to: "Ungrouped", then each separator in the order the view shows them, the current one marked. The mods become that separator's first mods, as shown. *catalog `move`, target Option; MO2's Send to Separator*
2. For a separator, a pick of the other separators, in the order the view shows them. The separator and its mods land directly above the one I choose, as shown.
3. Esc to move nothing. *Esc changes nothing*

### Add separator

As a user, I want:

1. A prompt for the name. Esc or an empty name adds nothing. A name another separator has is refused in the prompt: "A separator with this name already exists". *MO2*
2. On a mod, the new separator to go directly on the mod's losing side, so the mod and the mods on its winning side in its separator join it. On a separator, on the winning side of that separator's last mod, taking none. With losing at the top, that is directly above the mod, and directly below the separator's last mod, as shown. *catalog `add`, position; A gesture is atomic*

### Rename separator

As a user, I want a prompt filled with the current name. Esc, an empty name or the same name renames nothing. A name another separator has is refused in the prompt, as for add. *MO2*

### Delete separator

As a user, I want one confirmation for the selection that says the mods stay. *MO2; Confirm what destroys*

### Create empty mod and install

As a user, I want:

1. A prompt for the name. A name a mod already has is refused in the prompt, before anything is written, with one wording for create and install. Esc creates nothing. *MO2*
2. Install from the Mods menu to ask first for an archive or a folder, then open a file picker or a folder picker. *catalog `install`, Argument: an archive or a folder*
3. The name prompt filled with the archive's name without its extension, or the folder's name. *MO2*

### What install does

Install is offered here and on [Downloads](downloads.md#the-install-target). As a user, I want:

1. Install never to merge into an existing folder, or to replace one I did not confirm.
2. A new mod to appear at the winning end of the mod order, disabled, as any folder new in `mods/` does.
3. An upgrade to replace the mod's files in place, and to keep its folder name, its repository and its plugin source (`.git`, `.gitignore` and `plugin-source/`). *ADR-0007*
4. An upgrade to keep every `meta.ini` value the new file does not know, so an unknown version never blanks a known one. *ADR-0017*
5. An upgrade that fails part way to say so, naming the folder and what failed, and not to roll back. Installing again is the recovery, and a tracked mod's plugin source stays in git. This is an exception to *A failed gesture writes nothing*.

### Uninstall

As a user, I want one confirmation for the whole selection, naming the mod when there is one and listing the mods when there are several, and saying the folders go to the trash. *Confirm what destroys; MO2's recycle bin*

### Go to mod

As a user, I want a pick of the mods the file wins over, in mod order, when there are several. Esc selects nothing. *catalog `go to mod`, Options; Esc changes nothing*

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A FOMOD installed as a plain copy to raise a notification that its files need arranging by hand, because the installer's own steps did not run. *ADR-0019*
2. When `mods/` cannot be listed, `modlist.txt` untouched, and the reason in the view's message line and the Output.
3. An uninstall or a separator delete that trashed the folder, and then failed on its line, reported as done, with a line in the Output: `mod sync` drops the line. This is an exception to *A failed gesture writes nothing*.
4. An uninstall that landed, and then failed to mark its downloaded file uninstalled, not reported as failed. The failed `.meta` write is a line in the Output.

## Test seam

- **The view, given an instance value:** the rows, their parents, each row's parts, the order in both directions, and the states, with no VS Code UI and no disk.
- **A gesture's entry:** given the right-clicked row, the focused row and the selection, the Argument the command receives.
- **A drop:** given what is dragged, the target and the direction, the move's Argument and target.
- **The pickers and prompts:** their items, prefill, refusals, and what Esc yields.
- **The files, given an instance value and the settings:** each mod's and Overwrite's files, each one active or inactive and why, the indicators each mod carries, and the filter at every level.
- **Menus and keys:** the placement above, checked against the extension manifest.

