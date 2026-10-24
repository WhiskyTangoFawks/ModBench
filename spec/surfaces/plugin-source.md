# Plugin source

The plugin source is a compiled plugin's text, and compile builds the plugin from it ([ADR-0006](../adr/0006-a-compiled-plugins-truth-is-its-plugin-source.md)). Decompile and commit, and decompile, write it into the mod's repository, in the source folder beside `mods/`, under `plugin-source/`, and I read, diff and edit it as I would any source code. Its layout is Modbench's schema: Mutagen's serialization gives the structure, and Modbench changes it in the few places the stories below need. Mutagen decides what a record holds; Modbench decides where the text departs from Mutagen's, and nothing else does. Neither xEdit nor MO2 has a source, so every story is owned here.

## The tree

As a user, I want:

1. To find a record by its file: one folder for each plugin, and one file for each record, named by its EditorID when it has one, then its FormKey, except a child record (story 3).
2. A diff to hold only what changed in the plugin. An insert or a delete touches one record's file, and an insert also moves the Next Object ID in the plugin header's file. A reorder reads as a reorder, nothing is re-sorted, and decompiling an unchanged plugin changes nothing. Cites: ADR-0006
3. A record and its child records in one file, so a change to a cell or a quest is one file to review. A worldspace's grid cells are each a file of their own. Cites: ADR-0020
4. Never to edit or merge a value the plugin derives, in the header or in a record: it is not in the source. The masters and the record count are not, so branches never conflict over them. The Next Object ID is in the source, as Mutagen holds it, so two branches that add records both move it in the header. Cites: ADR-0008; Mutagen's data; ruling

## Decompile and compile

As a user, I want:

1. To decompile any plugin in my modlist, whatever tool wrote it and however it bends convention.
2. To trust the source: it says what the plugin means, and compiling it unchanged gives a plugin that means the same, though its bytes may differ. Cites: ADR-0006
3. To be told when a plugin cannot become source without losing meaning, and never to get a source that quietly lost it. The refusal names the record, and says whether the plugin is malformed or Mutagen mishandles it, because the remedy differs. Cites: Never silently wrong; GLOSSARY.md, Malformed plugin
4. To take the author's new release into my edits myself: decompile it onto the mod's `main`, then merge my branch with git, where each conflict lands in one record's file. Cites: ADR-0007

## Decompile and repair

This is an exception to Refuse, do not repair ([commands.md](commands.md)): I run it on purpose, and it names every change before it writes.

As a user, I want:

1. To run Decompile and repair on a malformed plugin from its Problems entry or its row in the plugins list. Cites: GLOSSARY.md, Malformed plugin
2. A preview that names each change with its record, and any data the change drops, before anything is written. Cites: Never silently wrong
3. A repair that drops data to write nothing until I agree to that data. This is an exception to commands.md, Principles, Confirm what destroys. Cites: Never silently wrong; agent.md, Any agent, story 7
4. A diagnosis that no repair answers to show itself, with no repair offered. Cites: Refuse, do not repair
5. A repair refused, naming the change, when the plugin's bytes changed after the preview. Cites: ADR-0003
6. Two commits in the mod's plugin source, both or neither. The first holds every other record as it is, and each malformed record with as much of it as can be read, as its raw subrecords where nothing else reads, and a field in its file that holds its diagnosis. The second holds only the repaired records. The history then shows what the repair changed. Cites: ADR-0006; ADR-0007; commands.md, Principles, A failed gesture writes nothing
7. When the mod has no source repository, the repair creates one, and decompiles the mod's other plugins with it, as decompile and commit does. Cites: commands.md, decompile and commit

## Changes outside Modbench

The source is files, and any tool can change them. As a user, I want:

1. A change made outside Modbench to compile like any other: a deleted file deletes its record, and an added file adds one. Cites: ADR-0003
2. Compile to stop on a file it cannot read, on a file that holds what no plugin can hold, and on two files that claim one FormKey, naming every such file and the field at fault where there is one, so a broken change never becomes a broken plugin. A misspelled field, a value the plugin derives (The tree, story 4) and an element the plugin would drop are things no plugin can hold. Spacing and key order alone change no meaning. Cites: Never silently wrong; ADR-0006
3. A record file in the wrong place to compile, with a warning naming where it belongs. Modbench's next write to that record moves it there. Cites: Never silently wrong

## In the text editor

A FormKey is a symbol, and the record index answers for it ([ADR-0001](../adr/0001-modbench-is-a-vscode-extension.md)). The gestures are VS Code's own, under VS Code's names and keys, so none is a catalog row.

As a user, I want:

1. Go to Definition on a FormKey to open the record, as Opening in [editor.md](editor.md) opens a record given without a plugin. Cites: VS Code; xEdit Ctrl + click
2. Find All References on a FormKey to list every record that references it, one entry for each plugin's copy, in the peek and in the References view. Cites: VS Code; [editor-referenced-by.md](editor-referenced-by.md), The tree, stories 1, 2 and 4
3. Hovering a FormKey to show `EditorID [FormKey]`, the record type, and the plugin whose copy wins. Cites: xedit.md, divergence 10
4. Go to Symbol in Workspace to find a record by EditorID or FormKey across every compiled plugin, and to open it. Cites: VS Code; catalog `open` with no Argument
5. Completion inside a reference field to offer records by EditorID and insert the FormKey, and inside an enum field to offer its values. Cites: VS Code; ADR-0005
6. The Problems panel to carry, on the plugin source of every compiled plugin, active or not, each refusal and warning compile would give that file, and a reference to a record that neither its plugin nor an active plugin holds. A problem appears as I type and clears the same way, since the record index reads the unsaved document (ADR-0001). When mEdit cannot answer, the problems stay, and the language status says "Showing the last good read:" and the reason, with one line in the Output. No notification. The next good answer clears it. Cites: Changes outside Modbench, stories 2 and 3; ADR-0015; ADR-0012; common, States, story 6; ADR-0019; VS Code's language status
7. Rename Symbol and the quick fixes to offer nothing on plugin source: changing a FormKey is editing the FormID field, and updating the references is a script. Cites: xedit.md, divergence 9
8. A language feature that fails to answer as any language server's feature does: with what it found, and a line in the Output for each reason. Cites: VS Code; ADR-0019
