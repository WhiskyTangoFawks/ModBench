# Plugin source

The plugin source is a tracked plugin's text, and compile builds the plugin from it ([ADR-0006](../../adr/0006-a-tracked-plugins-truth-is-its-source.md)). Track and decompile write it into the mod's working tree, under `plugin-source/`, and I read, diff and edit it as I would any source code. Its layout is Modbench's schema: Mutagen's serialization gives the structure, and Modbench changes it in the few places the stories below need. Mutagen decides what a record holds; Modbench decides where the text departs from Mutagen's, and nothing else does. Neither xEdit nor MO2 has a source, so every story is owned here.

## The tree

As a user, I want:

1. To find a record by its file: one folder for each plugin, and one file for each record, named by its EditorID when it has one, then its FormKey, except a child record (story 3).
2. A diff to hold only what changed in the plugin. An insert or a delete touches one record's file, a reorder reads as a reorder, nothing is re-sorted, and decompiling an unchanged plugin changes nothing. Source: ADR-0006
3. A record and its child records in one file, so a change to a cell or a quest is one file to review. A worldspace's grid cells are each a file of their own. Source: ADR-0020
4. Never to edit or merge a value the plugin derives. The masters, the next FormID and the record count are not in the source, so two branches that add records never conflict over them. Source: ADR-0008; ruling

## Decompile and compile

As a user, I want:

1. To decompile any plugin in my modlist, whatever tool wrote it and however it bends convention.
2. To trust the source: it says what the plugin means, and compiling it unchanged gives a plugin that means the same, though its bytes may differ. Source: ADR-0006
3. To be told, naming the record, when a plugin cannot become source without losing meaning, and never to get a source that quietly lost it. Source: Never silently wrong
4. To take a new upstream version into my edits myself: decompile it onto the mod's `main`, then merge my branch with git, where each conflict lands in one record's file. Source: ADR-0007

## Changes outside Modbench

The source is files, and any tool can change them. As a user, I want:

1. A change made outside Modbench to compile like any other: a deleted file deletes its record, and an added file adds one. Source: ADR-0003
2. A file compile cannot read, or two files that claim one FormKey, to stop compile, naming the files, so a broken change never becomes a broken plugin. Source: Never silently wrong
3. A record file in the wrong place to compile, with a warning naming where it belongs. Modbench's next write to that record moves it there. Source: Never silently wrong

## In the text editor

A FormKey is a symbol, and the index answers for it ([ADR-0001](../../adr/0001-modbench-is-a-vscode-extension.md)). The gestures are VS Code's own, under VS Code's names and keys, so none is a catalog row.

As a user, I want:

1. Go to Definition on a FormKey to open the record, as Opening in [editor.md](editor.md) opens a record given without a plugin. Source: VS Code; xEdit Ctrl + click
2. Find All References on a FormKey to list every record that references it, one entry for each plugin's copy, in the peek and in the References view. Source: VS Code; [editor-referenced-by.md](editor-referenced-by.md), The tree, stories 1 to 4
3. Hovering a FormKey to show `EditorID [FormKey]`, the record type, and the plugin whose copy wins. Source: xedit.md, divergence 10
4. Go to Symbol in Workspace to find a record by EditorID or FormKey across every tracked plugin, and to open it. Source: VS Code; catalog `open` with no Argument
5. Completion inside a reference field to offer records by EditorID and insert the FormKey, and inside an enum field to offer its values. Source: VS Code; ADR-0005
6. The Problems panel to carry, on the file, what compile would refuse and a reference to a record no active plugin holds. A problem appears when the file is saved and clears the same way, since the index reads the file. Source: Changes outside Modbench, story 2; ADR-0015
7. Rename Symbol and the quick fixes to offer nothing on plugin source: changing a FormKey is editing the FormID field, and updating the references is a script. Source: xedit.md, divergence 9
