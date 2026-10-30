# Downloads

The Downloads surface lists the instance's downloaded files. Its template is MO2's Downloads tab ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs, [mo2.md](../out-of-scope/mo2.md) says why. Its gestures are in [commands.md](commands.md). What every view shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## The view

A native tree view (commands.md, Where surfaces live). The list is flat: every row is a leaf, so it has no Collapse All (Chrome).

## Which files are rows

As a user, I want:

1. One row for each file directly in the instance's downloads folder, as the mod manager names and resolves it, even when it lies outside the instance. Cites: MO2
2. Only a file install can take to be a row. Install owns the list of extensions. Cites: MO2 lists files by the installers' extensions, never folders
3. A file's metadata, which the mod manager keeps beside it, never to be a row. It is the data behind its file's row. Cites: MO2
4. A file with no metadata to be an ordinary row, with none of its fields. Cites: MO2
5. Metadata whose file is gone to show nothing, and to stay on disk. Cites: ADR-0003; mo2.md, Downloaded file, Delete orphaned .meta files on refresh

## A row

| Part | What it shows | Cites |
|---|---|---|
| Label | the name in its metadata, or the file name when that is missing or empty | MO2 |
| Description | the version in its metadata, then the status word | common, A view, story 3 |
| Icon | the status: Downloaded `$(archive)` green, Installed `$(check)`, Uninstalled `$(circle-slash)` yellow | MO2's status colours |
| Tooltip | file name, mod name, version, Nexus mod ID, size, file time, game and author, each only when known | MO2's columns |
| Identity | the file, so an edit to the name in its metadata keeps the row selected | |
| Excluded | shown only while show excluded is on, dimmed, among the other rows in sort order | mo2.md, divergence 5 |

A Nexus mod ID or file ID the mod manager records as none is no ID. Cites: MO2

The status, first match wins:

| When | Status |
|---|---|
| a mod in the instance, enabled or not, was installed from this file | Installed |
| the file was installed once, and no mod from it is left | Uninstalled |
| it was never installed | Downloaded |

The row stays right when I or another tool remove a mod. Cites: ADR-0003

Install and uninstall keep the mod manager's own list of downloaded files in agreement. Cites: Never break the instance for its owner

## Order and view state

As a user, I want:

1. The newest file first, by file time, until I choose otherwise. Cites: mo2.md, divergence 6
2. To sort by name (the label), status, size or file time, in either direction, from a pick in the title bar's overflow. The pick marks the current sort. Cites: catalog `sort`; Chrome
3. Rows that tie to keep their order, in both directions.
4. Show excluded to decide which rows exist, and the name filter to narrow what is left.

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no downloaded files, a message saying there are none yet, and that an installable file copied into the downloads folder shows up here.
2. With files that are all excluded while show excluded is off, a message saying so. Cites: Never silently wrong

## Menus and keys

| Where | Items, in order |
|---|---|
| Title bar | 1: filter, or clear filter while active. 2: show excluded, or hide excluded while shown. Overflow: sort. |
| Row menu | install · query info (the file's metadata lacks its Nexus IDs, and I am logged in) · view on Nexus (the file has a Nexus mod ID) · open · open metadata (the file has one) · exclude or include · copy value · delete |
| Keys | Ctrl+C: copy value. Delete: delete. |

As a user, I want:

1. Exclude and include over a selection that mixes excluded and included rows to apply the right-clicked row's direction to every row. Cites: mods.md, Menus and keys, story 2
2. To install only from the row menu. A double click, Enter or a drag onto the Mods view installs nothing. Cites: mo2.md, Downloaded file
3. Copy value to copy each selected file's file name. Cites: catalog `copy value`

## Pickers and confirmations

### Delete

As a user, I want:

1. The files sent to the trash, with no confirmation. Cites: catalog `delete`; mo2.md, divergence 23
2. The installed mod to be untouched. Cites: MO2

### The install target

There is no file picker: the row supplies the downloaded file (commands.md, The entry point supplies what it knows). As a user, I want:

1. A pick whenever an installed mod that is not a source mod shares the file's Nexus mod ID: one item for each such mod, showing its name and version, and a last item, "Install as a new mod…".
2. No pick otherwise: the file installs as a new mod.
3. An upgrade only when I choose it.
4. The mod whose installed files record this file's Nexus file ID named "File ID match", listed first and pre-selected. With no such mod, the mod whose metadata records this file as its installation file named "Installed from this file", listed first and pre-selected. With neither, "Install as a new mod…" is pre-selected. The pre-selection never matches the file's name against a mod's.
5. Esc to install nothing. Cites: Esc changes nothing
6. A new mod to go on to the name prompt, and an upgrade not to.
7. A file with no Nexus mod ID in its metadata to take one from its file name, so story 1's pick still finds the mod I am upgrading. Cites: MO2

What install then does is in [mods.md](mods.md#what-install-does).

## Query info

As a user, I want:

1. Each file looked up on Nexus, and its metadata written as the mod manager writes it. Install then finds the mod I upgrade, and the manifest names the file's page on Nexus. Cites: MO2's Query Info (MD5)
2. A value already in the metadata that Nexus does not know kept, as an upgrade keeps a mod's (mods.md, What install does, story 4). Cites: Never silently wrong
3. A file Nexus does not know left as it was, and named in the Output (Reporting, story 3). Cites: Never silently wrong

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. An install that landed, and then failed to write its metadata, not reported as failed: the row still shows Installed, and the failed metadata write is a line in the Output. A gesture reported as failed is one I would retry.
2. A delete that moved the file to the trash and then failed on its metadata reported as done, with a line in the Output naming the metadata left behind. The row is gone and lone metadata shows nothing, so no view is untrue. Cites: Which files are rows, story 5
3. Query info to say in one line how many files it filled, with each file Nexus does not know in the Output.
