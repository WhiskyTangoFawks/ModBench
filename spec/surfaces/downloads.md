# Downloads

The Downloads surface lists the instance's downloaded files. Its template is MO2's Downloads tab ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs, [mo2.md](../out-of-scope/mo2.md) says why. Its gestures are in [commands.md](commands.md) under Downloaded file, with `install` under Mod. What every view shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## The view

A native tree view, `modbench.downloads`, fourth in the `modbench` container and collapsed by default (commands.md, Where surfaces live). VS Code's own "Focus on Downloads View" opens it; it has no command of its own. The list is flat: every row is a leaf, so it has no Collapse All (Chrome).

## Which files are rows

As a user, I want:

1. One row for each file directly in the instance's downloads folder: the folder MO2's configuration names, resolved as MO2 resolves it, `%BASE_DIR%` included, even when it lies outside the instance. `downloads/` unless I moved it. Cites: MO2
2. Only a file install can take to be a row. Install owns the list of extensions. A subfolder, a readme or any other file is not a row. Cites: MO2 lists files by the installers' extensions, never folders
3. A file's metadata, which MO2 keeps in a `.meta` sidecar, never to be a row. It is the data behind its file's row. Cites: MO2
4. A file with no metadata to be an ordinary row, Downloaded, with none of its fields. Cites: MO2
5. Metadata whose file is gone to show nothing, and to stay on disk. MO2 deletes it on refresh; Modbench never deletes a file silently. Cites: ADR-0003; mo2.md

## A row

| Part | What it shows | Cites |
|---|---|---|
| Label | the name in its metadata, or the file name when that is missing or empty. Never blank. | MO2 |
| Description | the version in its metadata, then the status word, which is left out for Downloaded | common, A view, story 3 |
| Icon | the status: Downloaded `$(archive)` green, Installed `$(check)` uncoloured, Uninstalled `$(circle-slash)` yellow. No file-type icon: the icon carries the status. | MO2's status colours |
| Tooltip | file name, mod name, version, Nexus mod ID, size, file time, game and author, each only when known. A tree has no columns, so size and file time live here. | MO2's columns |
| Identity | the file name, never the label, so an edit to the name in its metadata keeps the row selected | |
| Excluded | shown only while show excluded is on, dimmed, among the other rows in sort order | mo2.md, divergence 5 |

A Nexus mod ID or file ID of `0` is no ID. Cites: MO2

The status, first match wins:

| When | Status |
|---|---|
| a mod in the instance, enabled or not, was installed from this file | Installed |
| the file was installed once, and no mod from it is left | Uninstalled |
| it was never installed | Downloaded |

A mod in the instance decides Installed. The row stays right when I or another tool remove a mod. Cites: ADR-0003

Install and uninstall keep MO2's own Downloads tab in agreement. Cites: Never break the instance for its owner

## Order and view state

As a user, I want:

1. The newest file first, by file time, until I choose otherwise. Cites: mo2.md, divergence 6
2. To sort by name (the label), status, size or file time, in either direction, from a pick in the title bar's overflow. The pick marks the current sort. Cites: catalog `sort`; Chrome
3. Rows that tie to keep their order, in both directions, because status has three values and ties are common.
4. Show excluded to decide which rows exist, and the name filter to narrow what is left.

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no downloaded files, a message saying there are none yet, and that an installable file copied into the downloads folder shows up here.
2. With files that are all excluded while show excluded is off, a message saying so, never "none yet". Cites: Never silently wrong

## Menus and keys

| Where | Items, in order |
|---|---|
| Title bar | 1: filter, or clear filter while active. 2: show excluded, or hide excluded while shown. Overflow: sort. |
| Row menu | install · query info (the file's metadata lacks its Nexus IDs, and I am logged in) · view on Nexus (the file has a Nexus mod ID) · open · open metadata (the file has one) · exclude or include · copy value · delete |
| Keys | Ctrl+C: copy value. Delete: delete. |

As a user, I want:

1. Exclude and include over a selection that mixes excluded and included rows to apply the right-clicked row's direction to every row, because a menu condition cannot see the mix. A row already in that state is left alone. Cites: MO2's Hide All; Doing nothing is not an error
2. To install only from the row menu. A double click, Enter or a drag onto the Mods view installs nothing. Cites: mo2.md, Downloaded file
3. Copy value to copy each selected file's file name. Cites: catalog `copy value`

## Pickers and confirmations

### Delete

As a user, I want:

1. The files sent to the trash. Cites: mo2.md, divergence 23
2. The installed mod to be untouched. Cites: MO2

### The install target

There is no file picker: the row supplies the downloaded file (commands.md, The surface supplies the Argument). As a user, I want:

1. A pick whenever an installed mod shares the file's Nexus mod ID: one item for each such mod, showing its name and version, and a last item, "Install as a new mod…".
2. No pick when no installed mod shares the ID, or the file has none: the file installs as a new mod.
3. An upgrade only when I choose it, even when one item is pre-selected.
4. The mod whose installed files record this file's Nexus file ID named "File ID match", listed first and pre-selected. With no such mod, the mod whose metadata records this file as its installation file named "Installed from this file", listed first and pre-selected. With neither, "Install as a new mod…" is pre-selected. Never a pick from the file's name.
5. Esc to install nothing. Cites: Esc changes nothing
6. A new mod to go on to the name prompt, and an upgrade not to.
7. A file with no Nexus mod ID in its metadata to take one from its file name, so story 1's pick still finds the mod I am upgrading. Cites: MO2

What install then does is in [mods.md](mods.md#what-install-does).

## Query info

As a user, I want:

1. Each file looked up on Nexus by its MD5, and its metadata written as MO2 writes it. Install then finds the mod I upgrade, and the manifest names the file's page on Nexus. Cites: MO2's Query Info (MD5)
2. A value already in the metadata that Nexus does not know kept. Cites: mods.md, What install does, story 4
3. A file Nexus does not know left as it was. Cites: Never silently wrong

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. An install that landed, and then failed to write its metadata, not reported as failed: the row still shows Installed, and the failed metadata write is a line in the Output. A gesture reported as failed is one I would retry.
2. A delete that moved the file to the trash and then failed on its metadata reported as done, with a line in the Output naming the metadata left behind. The row is gone and lone metadata shows nothing, so no view is untrue. Cites: Which files are rows, story 5
3. Query info to say in one line how many files it filled, with each file Nexus does not know in the Output.

## Test seam

- The view, given an instance value: which rows exist, each row's parts, the order, and the states, with no VS Code UI and no disk.
- A gesture's entry: given the right-clicked row and the selection, the Argument the command receives.
- The pickers: their items, the pre-selected item, and what Esc yields, against a scripted quick pick.
- Menus and keys: the placement above, checked against the extension manifest. A `when` condition's truth is not tested.

