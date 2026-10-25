# Mods

The Mods surface shows the active profile's mod order: its mods, grouped by separators, and the Overwrite folder. Each mod and Overwrite opens into its files, and each file shows whether the game gets it. Its template is MO2's mod list ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs, [mo2.md](../out-of-scope/mo2.md) says why. Its gestures are in [commands.md](commands.md) under Mod and Separator. What every view shares is in [common.md](common.md). [mods-conflicts.md](mods-conflicts.md) holds the conflict table, which opens from a mod's row in an editor tab.

Each story cites what decides it. A story that cites nothing is owned here.

## The view

A native tree view, `modbench.modList`, second in the `modbench` container and open by default (commands.md, Where surfaces live). Separators hold the mods they group, and a mod or Overwrite holds its files, so it has Collapse All (Chrome).

The view's description shows how many mods are enabled out of how many are listed, counting the whole list even while a filter is active, then the filter's term: `12 / 30 · "arm"`. Cites: MO2's active-mod counter

The view's badge is the modlist's ([modlist-repository.md](modlist-repository.md), Status, story 5).

## The tree

As a user, I want:

1. One row for each mod or separator in the active profile's mod order. A mod the mod manager marks unmanaged is not a row. Cites: MO2, which hides unmanaged mods by default
2. Each separator to hold the mods between it and the next separator toward the winning end, whichever way the list is sorted. Cites: GLOSSARY.md, Mod separator; MO2
3. The mods on the losing side of the first separator to be ungrouped: top-level rows at the losing end of the view. Cites: MO2
4. The Overwrite row pinned at the winning end, outside every separator: last when losing is at the top, first when winning is. Cites: MO2: Overwrite wins over every mod
5. Separators, mods, Overwrite and folders collapsed each time the extension activates, so the view opens clean. What I expand stays expanded until then.
6. A separator with no mods to show no expander. Cites: VS Code
7. A mod or Overwrite to open into its files as a folder tree: folders first, then files, each by name. A disabled mod opens too. One with no files shows no expander. Cites: VS Code's Explorer
8. The name of a file the game does not get to be greyed. The game does not get a file when another copy wins its path, when it is excluded, or when its mod is disabled. Cites: MO2
9. Only the mod's own files to show: not the mod manager's metadata or the manifest. An excluded file shows its name as the mod manager marks it, as MO2's `.mohidden` suffix. A folder so marked is excluded with everything in it, and is greyed. Cites: MO2
10. The same grey and badges on the same files in VS Code's Explorer. Cites: VS Code
11. The mods and Overwrite related to my selection in Plugins highlighted ([plugins.md](plugins.md), The highlight), and a collapsed separator highlighted while a mod it holds is highlighted. Cites: MO2

## A row

### Mod

| Part | What it shows | Cites |
|---|---|---|
| Label | the mod's name | MO2 |
| Check box | checked when the mod is enabled | MO2 |
| Description | the version in the mod's metadata, then the mod's status against its manifest ([modlist-repository.md](modlist-repository.md), Status) | MO2 |
| Icon | `$(package)`, or `$(repo)` for a source mod | |
| Indicators | a badge at the right edge, and a colour on the label, for each indicator that holds ([Indicators](#indicators)) | MO2's Conflicts and Flags columns |
| Tooltip | name, version, Nexus mod ID and installation file, each only when known, and, for a source mod, its source folder and that the folder is built from it, then the files its folder lacks ([modlist-repository.md](modlist-repository.md), Status, story 4) | MO2's columns |
| Identity | the row's kind and the mod's name, so selection and expansion survive a change on disk. A mod and a separator can share a name. | |

### Separator

| Part | What it shows | Cites |
|---|---|---|
| Label | the separator's name, without MO2's `_separator` suffix | MO2 |
| Check box, icon | none | MO2 draws a separator as a heading |
| Description | its status against its manifest ([modlist-repository.md](modlist-repository.md), Status, story 7) | |
| Identity | the row's kind and the separator's name | |

### Overwrite

| Part | What it shows | Cites |
|---|---|---|
| Label | Overwrite | MO2 |
| Description | the number of files it holds, left out when it holds none | |
| Icon | `$(folder)`, tinted when it holds files, with no badge | |
| Tooltip | what Overwrite is: the files tools wrote while MO2 ran them, which win over every mod | MO2 |

Overwrite is always a row, even when it holds nothing. It is not a mod: it has no check box and cannot be dragged. Cites: MO2

### File and folder

| Part | What it shows | Cites |
|---|---|---|
| Label | the file's or folder's name | VS Code's Explorer |
| Icon | the file icon theme's icon | VS Code's Explorer |
| Colour | greyed when the game does not get the file (The tree, story 8) | |
| Description | differs ([modlist-repository.md](modlist-repository.md), Status) | |
| Indicators | a badge at the right edge for each publisher tag that covers it ([Indicators](#indicators)) | [publishing.md](publishing.md), Publisher tags |
| Tooltip | the path in its mod | |
| Identity | the mod or Overwrite, and the path in it | |

## Indicators

A mod row carries an indicator for each status that holds, and a folder or file row one for each publisher tag that covers it. A disabled mod carries none but a publisher tag that covers it (publishing.md, Publisher tags, story 1). Each indicator has a badge and a colour, and my settings switch each on or off. Each colour is a theme colour Modbench contributes. Cites: MO2's Conflicts and Flags columns; editor-conflicts, The colours, story 1

| Indicator | Holds when | Badge | Colour |
|---|---|---|---|
| Overwrites loose files | a file of the mod wins over another copy | off | off |
| Overwritten loose files | a file of the mod loses to another copy, and the mod is not Redundant | on | off |
| Redundant | the mod has a file the game could get, and every such file loses to another copy | on | off |
| Contains excluded files | the mod has an excluded file | off | off |
| Update available | the mod's version is older than the newest version check for updates found | on | off |
| Publisher tag | a publisher tag covers the row ([publishing.md](publishing.md), Publisher tags, story 1) | on | off |

Each publisher tag is an indicator of its own, with the badge its publisher declares. The Badge and Colour columns are the defaults. The grey of a file the game does not get is a setting too, on by default. A mod that wins some files and loses others carries both badges. Each indicator's tooltip is its name in this table. Cites: mo2.md, divergence 12

## A source mod

A source mod's folder is its build's output ([ADR-0007](../adr/0007-plugin-edits-are-git-working-tree-changes.md)). As a user, I want:

1. Its row to open into the folder's files as any mod's, since they are what the game gets. The source is in the Explorer and Source Control, and `open source` shows it. Cites: catalog `open source`
2. Rename and exclude or include to write the manifest and the folder together, so the folder already equals the next build's output: rename changes the output folder's name (Rename mod, story 3), and exclude or include its exclusions, which build writes with the mod manager's exclusion mark. Cites: ADR-0007
3. No gesture that changes content the build makes. A record edit goes to plugin source, a plugin created lands in it, and decompile reads the folder into it. Cites: ADR-0006; ADR-0007
4. A file I change in the folder to show as differing from the manifest, and build to overwrite it and name it. A lock on the folder is mine to add with VS Code's `files.readonlyInclude`. Cites: modlist-repository.md, Status; VS Code's interaction
5. Uninstall to send the folder and the source to the trash, and the confirmation to say so. Cites: Confirm what destroys

## Order and view state

As a user, I want:

1. Losing at the top until I choose otherwise, and a title-bar toggle that flips the whole tree, separators and the mods inside them. Cites: MO2's priority sort; common, A view, story 7
2. The name filter to match the name of any row: a separator, a mod, a folder or a file. A row whose name matches shows all its children; otherwise it shows only its matching children, expanded, and one with none is not shown. Overwrite stays, and does not count as a match; its files follow the same rule. Cites: common, The name filter
3. A toggle in the filter box to show the matches as a flat list, with no separators. Mods still open to their matching files. It returns to grouped whenever the filter clears.

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no mods and no separators, the view's message line to say so and to name install and create empty mod, in the title bar's overflow.

## Menus and keys

The row menus follow VS Code's groups: open, change, create, source control, copy, then destroy.

| Where | Items, in order |
|---|---|
| Title bar | 1: filter, or clear filter while active. 2: sort direction. Overflow: install… · create empty mod · check for updates, on every mod (I am logged in) · update manifest · restore from manifest…, on every mod (the instance has a repository). Collapse All last. |
| Mod menu | open folder · open source (a source mod) · open conflicts · view on Nexus (the mod has a Nexus mod ID) · enable or disable · move… · rename… · add publisher tag… (the instance has a publisher) · remove publisher tag… (the row holds a publisher tag) · check for updates (the mod has a Nexus mod ID, and I am logged in) · add separator · create empty mod · install… · decompile and commit (a mod with no source that holds a plugin) · build (a source mod) · update manifest · restore from manifest… (the instance has a repository) · copy value · uninstall |
| Separator menu | move… · add separator · rename… · check for updates (I am logged in) · update manifest · restore from manifest… (the instance has a repository) · copy value · delete |
| Overwrite menu | open folder |
| File menu | open folder · compare file (a file in a file order conflict, not the winning copy) · go to mod (a file in a file order conflict) · exclude or include · add publisher tag… (the instance has a publisher whose publisher tags mark paths) · remove publisher tag… (the row holds a publisher tag) · copy value |
| Folder menu | open folder · add publisher tag… (the instance has a publisher whose publisher tags mark paths) · remove publisher tag… (the row holds a publisher tag) · copy value |
| Check box | enable or disable |
| Keys | Space: enable or disable. Delete: uninstall, or delete a separator. F2: rename a mod or a separator. Ctrl+C: copy value. |

As a user, I want:

1. Each menu item to act on the row I right-clicked, or on the whole selection, as the gesture's Argument in the catalog says. Cites: catalog Argument
2. Enable or disable, over a selection that mixes enabled and disabled mods, to apply the right-clicked row's direction to every mod. Space takes the focused row's direction. A mod already in that state is left alone. Cites: MO2; Doing nothing is not an error
3. Delete to act on the selected rows of the focused row's kind: uninstall for mods, delete for separators.
4. A click or double click on a separator, a mod, Overwrite or a folder to do nothing but select it, which highlights its related rows ([plugins.md](plugins.md), The highlight); its expander opens it. A click on a file opens it as a preview editor. Cites: VS Code's Explorer
5. Copy value to copy each selected mod's or separator's name, and each selected file's or folder's path in its mod. Cites: catalog `copy value`
6. Go to mod to select, in this tree, the row it names. Cites: catalog `go to mod`; MO2's Go to...
7. Exclude or include, over a selection that mixes both, to apply the right-clicked row's direction to every file, as enable or disable does. Cites: story 2
8. Space, Delete and F2 to do nothing on a file or folder: the tree shows files, and the Explorer manages them. This is an exception to common, A view, story 5.

## Drag and drop

As a user, I want:

1. To drag mods and separators, one or several. A separator brings every mod it holds. Cites: MO2
2. A drop of mods on a mod to place them directly above it, as shown, in that mod's separator.
3. A drop on a separator to make the mods I dragged its first mods, as shown. A separator dropped on a separator lands directly above it, as shown.
4. A drop below the last row to place what I dragged at the bottom of the view, as shown, above Overwrite when Overwrite is last.
5. A drop where what I dragged cannot go to change nothing and say nothing: on Overwrite, on a row I am dragging, inside a separator I am dragging, or a separator on a mod. Cites: MO2 refuses a separator on a mod; Doing nothing is not an error
6. Nothing from outside the view to drop here: no folder, file or downloaded file. Cites: mo2.md
7. Files and folders not to drag, and nothing to drop on them.

## Pickers, prompts and confirmations

### Move

As a user, I want:

1. For mods, a pick of the places to move to: "Ungrouped", then each separator in the order the view shows them, the current one marked. The mods become that separator's first mods, as shown. Cites: catalog `move`, target Option; MO2's Send to Separator
2. For a separator, a pick of the other separators, in the order the view shows them. The separator and its mods land directly above the one I choose, as shown.
3. Esc to move nothing. Cites: Esc changes nothing

### Add separator

As a user, I want:

1. A prompt for the name. Esc or an empty name adds nothing. A name another separator has is refused in the prompt: "A separator with this name already exists". Cites: MO2
2. On a mod, the new separator to go directly on the mod's losing side, so the mod and the mods on its winning side in its separator join it. On a separator, on the winning side of that separator's last mod, taking none. With losing at the top, that is directly above the mod, and directly below the separator's last mod, as shown. Cites: catalog `add`, position; A gesture is atomic

### Rename separator

As a user, I want a prompt filled with the current name. Esc, an empty name or the same name renames nothing. A name another separator has is refused in the prompt, as for add. Cites: MO2

### Rename mod

As a user, I want:

1. A prompt filled with the current name. Esc, an empty name or the same name renames nothing. Cites: MO2
2. A name another mod has, compared without case, refused in the prompt, so Windows and Linux agree. A name with a path separator refused. Cites: MO2 compares without case; Refuse, do not repair
3. The mod to keep its place in mod order, its enabled state and its separator in every profile. Its folder keeps its metadata and its manifest, and its plugins keep their `plugins.txt` lines. For a source mod, rename changes the output folder in the manifest and renames the folder; the repository stays where it is. Cites: MO2; ADR-0007
4. The folder renamed first. A rename that renamed the folder and then failed on a profile's mod order to say so, naming the profile. That profile loses the mod's place, and `mod sync` places it as a new folder when the profile is active. This is an exception to A failed gesture writes nothing.

### Build

As a user, I want:

1. Build to write the mod folder from its repository and the installation files its manifest names, without asking: the source's assets copied, each plugin compiled from its plugin source, its steps run in order, and the manifest's file lines written last. A compiled plugin's source is the truth, and build makes the folder from it. Cites: catalog `build`; ADR-0006; ADR-0007; ADR-0023
2. The manifest to name the output folder and, for each archive to pack, the loose files it takes. A packed file is in the archive and not loose in the output, so the game reads one copy.
3. A file in the folder the build did not make left where it is, and the mod shown as differing from its manifest. Restore from manifest removes it. Cites: ADR-0022
4. A build whose manifest names an output folder that is not this mod's folder refused, naming both, so a folder renamed outside Modbench is never overwritten. Cites: ADR-0003
5. Build to save the mod's unsaved plugin source first, without asking, as Run Build Task saves before it builds, so the plugins are built from what I see. A file VS Code does not save refuses build, naming it. Cites: VS Code's save before run; ADR-0001; Never silently wrong
6. The view's progress bar while it runs, and a notification when it lands, pointing at the Problems panel when it left diagnostics. The diagnostics sit on the plugin source files.
7. From the palette with no mod, a pick of every source in the source folder, one with no folder included, so a clone builds its mods back. Cites: No dead entries
8. A plugin whose header flag limits its FormIDs, light or medium, refused when its records fall outside that range, naming the records, what limits the plugin, its flag, its `.esl` extension or both, and what lifts that limit: clear the flag, rename the plugin off `.esl`, or both. Changing the records' FormIDs works in every case. The rest of the mod builds, and the refused plugin is left as it was.
9. A plugin whose plugin source is unreadable refused the same way, naming it and pointing at decompile. Cites: Never silently wrong
10. An interrupted build to leave each file old or new, and none to read as changed outside Modbench. A localized plugin can be left with its strings written without its binary. Building again fixes it. This is an exception to A failed gesture writes nothing.
11. A patcher to be a source mod whose step runs its patching script on my load order, the script from its repository or an installation file. Its output joins the load order, so the next patcher reads it there.
12. Source mods built in mod order, the winning mod last, when build or restore builds more than one, so a patcher reads every mod before it, the patchers before it included.
13. No mod to say a patcher's output is stale. I rerun my patchers before I publish: whether a change before a patcher matters is mine to know, and most changes do not matter to a given patcher. This is an exception to Never silently wrong.
14. A step to run an external tool, such as a texture optimiser, named by its name alone. Each machine says where the tool is and how it runs, under Proton on Linux, so the manifest holds no path from this machine. Cites: modlist-repository.md, The manifest, story 8

### Delete separator

As a user, I want one confirmation for the selection that says the mods stay. Cites: MO2; Confirm what destroys

### Create empty mod and install

As a user, I want:

1. A prompt for the name. A name a mod already has is refused in the prompt, before anything is written, with one wording for create and install. Esc creates nothing. Cites: MO2
2. Install from the Mods menu to ask first for a file or a folder, then open a file picker or a folder picker. Cites: catalog `install`, Argument: a file or a folder
3. The name prompt filled with the file's name without its extension, or the folder's name. Cites: MO2

### What install does

Install is offered here and on [Downloads](downloads.md#the-install-target). As a user, I want:

1. Install never to merge into an existing folder, or to replace one I did not confirm.
2. A new mod to appear at the winning end of the mod order, disabled, as any folder new in `mods/` does.
3. An upgrade to replace the mod's files in place, and to keep its folder name and its manifest. Its repository is beside `mods/`, and an upgrade never touches it. Cites: ADR-0007; ADR-0022
4. An upgrade to keep every value in the mod's metadata that the new file does not know, so an unknown version never blanks a known one. Cites: ADR-0017
5. An upgrade that fails part way to say so, naming the folder and what failed, and not to roll back. Installing again is the recovery, and a source mod's plugin source stays in git. This is an exception to A failed gesture writes nothing.
6. A file or folder that holds a FOMOD to install through the FOMOD installer ([mods-fomod.md](mods-fomod.md)). Cites: MO2

### Uninstall

As a user, I want one confirmation for the whole selection, naming the mod when there is one and listing the mods when there are several, and saying the folders go to the trash, and a source mod's source with them. Cites: Confirm what destroys; MO2's recycle bin; A source mod, story 5

### Check for updates

As a user, I want:

1. No prompt. Each mod with a Nexus mod ID asked about, as MO2 does. Cites: MO2
2. The newest version written in the mod's metadata, where MO2 reads it, so MO2 shows the same update. Cites: Never break the instance for its owner
3. A mod with no Nexus mod ID, or one Nexus does not hold, left as it was and named in the Output. Cites: Never silently wrong

### Go to mod

As a user, I want a pick of the mods the file wins over, in mod order, when there are several. Esc selects nothing. Cites: catalog `go to mod`, Options; Esc changes nothing

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A FOMOD installed as a plain copy, by Manual or because its installer cannot run, to raise a notification that its files need arranging by hand, because the installer's own steps did not run, and why. Cites: ADR-0019
2. When `mods/` cannot be listed, the mod order untouched, and the reason in the view's message line and the Output.
3. An uninstall or a separator delete that trashed the folder, and then failed on its line, reported as done, with a line in the Output: `mod sync` drops the line. This is an exception to A failed gesture writes nothing.
4. An uninstall that landed, and then failed to mark its downloaded file uninstalled, not reported as failed. The failed metadata write is a line in the Output.
5. Check for updates to say in one line how many mods have an update, and how many it could not ask about.

## Test seam

- The view, given an instance value: the rows, their parents, each row's parts, the order in both directions, and the states, with no VS Code UI and no disk.
- A gesture's entry: given the right-clicked row, the focused row and the selection, the Argument the command receives.
- A drop: given what is dragged, the target and the direction, the move's Argument and target.
- The pickers and prompts: their items, prefill, refusals, and what Esc yields.
- The files, given an instance value and the settings: each mod's and Overwrite's files, each one active or inactive and why, the indicators each mod carries, and the filter at every level.
- Menus and keys: the placement above, checked against the extension manifest.

