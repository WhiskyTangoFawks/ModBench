# Mods

The Mods surface shows the active profile's mod order: its mods, grouped by separators, and the
Overwrite folder. Its template is MO2's mod list
([ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs,
[mo2.md](../../out-of-scope/mo2.md) says why. Its gestures are in [commands.md](../commands.md)
under Mod and Separator; what each one writes is in its trace. What every view shares is in
[common.md](common.md). The words are CONTEXT.md's: mod order, winning and losing, sort direction,
file order conflict.

Each story cites its source. A story with no source is owned here.

## The view

A native tree view, `modbench.modList`, second in the `modbench` container and open by default
(commands.md, Where surfaces live). Separators are its parents and the mods they group are their
children, so it has Collapse All (Chrome). Several rows can be selected at once. *catalog Argument:
mods*

The view's description shows how many mods are enabled out of how many are listed, counting the
whole list even while a filter is active, then the filter's term: `12 / 30 · "arm"`. *ruling; MO2's active-mod counter*

## The tree

As a user, I want:

1. One row for each line of the active profile's `modlist.txt` that names a mod or a separator. A
   line MO2 marks unmanaged (`*`) is not a row. *MO2, which hides unmanaged mods by default*
2. Each separator to hold the mods between it and the next separator toward the winning end, whichever
   way the list is sorted. *CONTEXT.md, Mod separator; MO2*
3. The mods before the first separator, at the losing end, to be ungrouped: rows of their own at the
   losing end of the view, above every separator when losing is at the top, below when winning is.
   *MO2*
4. The Overwrite row pinned at the winning end, outside every separator: last when losing is at the
   top, first when winning is. *MO2: Overwrite wins over every mod*
5. Separators collapsed each time the extension activates, so the view opens clean. What I expand
   stays expanded until then. *ruling*
6. A separator with no mods to show no expander. *VS Code*

## A row

### Mod

| Part | What it shows | Source |
|---|---|---|
| Label | the mod's name | MO2 |
| Check box | checked when the mod is enabled | MO2 |
| Description | the `meta.ini` version | MO2 |
| Icon | `$(package)` | |
| Tooltip | name, version, Nexus mod ID and installation file, each only when known | MO2's columns |
| Identity | the row's kind and the mod's name, so selection and expansion survive a change on disk. A mod and a separator can share a name. | |

A mod whose folder was deleted by hand is not a row: its line is pruned from `modlist.txt`, and the
row goes with it. *ruling; MO2*

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
| Icon | `$(folder)`, tinted when it holds files | tinted, no badge |
| Tooltip | what Overwrite is: the files tools wrote while MO2 ran them, which win over every mod | MO2 |

Overwrite is always a row, even when it holds nothing. It is not a mod: it has no check box and
cannot be dragged. *ruling; MO2*

## Order and view state

As a user, I want:

1. Losing at the top until I choose otherwise, and a title-bar toggle that flips the whole tree,
   separators and the mods inside them. It never changes which mod wins. *MO2's priority sort;
   CONTEXT.md, Sort direction*
2. The name filter to match mod and separator names. A separator whose name matches shows all its
   mods; otherwise a separator shows only its matching mods, expanded, and one with none is not
   shown. Overwrite stays, and does not count as a match. *common, The name filter*
3. A toggle in the filter box to show the matches as a flat list, with no separators. It returns to
   grouped whenever the filter clears.

The sort direction and the filter box's toggle reset when the extension activates (common, A view,
story 4).

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no mods and no separators, a message saying so, and that install or create empty mod, in the
   title bar's overflow, adds one. Overwrite is always a row, so the message is the view's message
   line, above it. *catalog Where*
2. The title bar's gestures absent while the folder is not an instance. *No dead entries*

## Menus and keys

The catalog decides which gestures this view offers and on what condition. This is where each sits.
The row menus follow VS Code's groups: open, change, create, source control, copy, then destroy.

| Where | Items, in order |
|---|---|
| Title bar | 1: filter, or clear filter while active. 2: sort direction. Overflow: install… · create empty mod. Collapse All last. |
| Mod menu | open folder · view on Nexus · enable or disable · move… · add separator · create empty mod · install… · track (holds an untracked plugin) · copy value · uninstall |
| Separator menu | move… · add separator · rename… · copy value · delete |
| Overwrite menu | open folder |
| Keys | Space: enable or disable. Delete: uninstall, or delete a separator. F2: rename a separator. Ctrl+C: copy value. Ctrl+F: filter. |

As a user, I want:

1. Each menu item to act on the row I right-clicked, or on the whole selection, as the gesture's
   Argument in the catalog says. *catalog Argument*
2. Keys that do what the same keys do in VS Code's Explorer. *common, A view, story 5*
3. Enable or disable, over a selection that mixes enabled and disabled mods, to apply the right-
   clicked row's direction to every mod. Space takes the focused row's direction. A mod already in
   that state is left alone. *MO2; Doing nothing is not an error*
4. Delete to act on the selected rows of the focused row's kind: uninstall for mods, delete for
   separators.
5. The check box to flip as I click it. If the write fails, it returns to what the disk says, and I
   am told why. *A write is forgotten; common, Reporting*
6. A click or double click on a row to do nothing but select it. *catalog: no row click on Mods*
7. Copy value to copy each selected mod's or separator's name, one to a line. *catalog `copy value`*

## Drag and drop

As a user, I want:

1. To drag mods and separators, one or several. A separator brings every mod it holds. *MO2*
2. A drop of mods on a mod to place them directly above it, as shown, in that mod's separator.
3. A drop on a separator to make the mods I dragged its first mods, as shown. A separator dropped on
   a separator lands directly above it, as shown.
4. A drop below the last row to place what I dragged at the bottom of the view, as shown, above
   Overwrite when Overwrite is last.
5. A drop where what I dragged cannot go to change nothing and say nothing: on Overwrite, on a row
   I am dragging, inside a separator I am dragging, or a separator on a mod. *MO2 refuses a
   separator on a mod; Doing nothing is not an error; collected in the CLAUDE.md review*
6. Nothing from outside the view to drop here: no archive, folder, file or downloaded file. *ruling;
   mo2.md*

A drop is `move`, so it is one gesture however it lands (commands.md, Entry points are not gestures).

## Pickers, prompts and confirmations

### Move

As a user, I want:

1. For mods, a pick of the places to move to: "Ungrouped", then each separator in the order the view
   shows them, the current one marked. The mods become that separator's first mods, as shown.
   *catalog `move`, target Option; MO2's Send to Separator*
2. For a separator, a pick of the other separators, in the order the view shows them. The separator
   and its mods land directly above the one I choose, as shown.
3. Esc to move nothing. *Esc changes nothing*

### Add separator

As a user, I want:

1. A prompt for the name. Esc or an empty name adds nothing. A name another separator has is refused
   in the prompt: "A separator with this name already exists". *MO2*
2. On a mod, the separator on the mod's losing side in mod order, so the mod and the mods on its
   winning side in its separator join the new one. On a separator, on the winning side of that
   separator's last mod, taking none. With losing at the top, that is directly above the mod, and
   directly below the separator's last mod, as shown. *ruling; catalog `add`, position; A gesture
   is atomic*

### Rename separator

A prompt filled with the current name. Esc, an empty name or the same name renames nothing. A name
another separator has is refused in the prompt, as for add. *MO2*

### Delete separator

See [update-load-order-file_draft.md](../traces/update-load-order-file_draft.md), question 1.

### Create empty mod and install

As a user, I want:

1. A prompt for the name. A name a mod already has is refused in the prompt, before anything is
   written, with one wording for create and install. Esc creates nothing. *MO2*
2. Install from the Mods menu to ask first for an archive or a folder, then open that picker.
   *catalog `install`: the Mods menu asks for the source*
3. The name prompt filled with the archive's name without its extension, or the folder's name. *MO2*

### Uninstall

As a user, I want one confirmation for the whole selection, naming the mod when there is one and
listing the mods when there are several, and saying the folders go to the trash. *Confirm what
destroys; MO2's recycle bin*

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A failed gesture's notification to say what failed and why, not only that it failed. *common,
   Reporting*
2. A FOMOD installed as a plain copy to raise a notification that its files need arranging by hand,
   because the installer's own steps did not run. *install-mod, new mod, story 3; ADR-0019,
   invariant 1*

## Deferred

| What | Waits on |
|---|---|
| A mod's file order conflicts: its status, its decoration and its contested files | the conflict UX design, #483 |
| `rename` a mod, and F2 on a mod | its design |
| `open details` and a double click that opens it, `highlight conflicts` | their design |
| `exclude / include file` | #483: where a mod's files are shown |
| `check for updates` and the update badge, `publish` | the Nexus API work |
| move targets: top, bottom, priority N, first or last conflict; add separator above or inside | the catalog's planned Options |
| install's position, installer choice and reinstall | the install workup, #959 |
| `open folder` in the native file tab, decorated by conflict status | #483 |

## Test seam

- **The view, given an instance value:** the rows, their parents, each row's parts, the order in both
  directions, and the states, with no VS Code UI and no disk.
- **A gesture's entry:** given the right-clicked row, the focused row and the selection, the
  Argument the command receives.
- **A drop:** given what is dragged, the target and the direction, the move's Argument and target.
- **The pickers and prompts:** their items, prefill, refusals, and what Esc yields.
- **Menus and keys:** the placement above, checked against the extension manifest.

