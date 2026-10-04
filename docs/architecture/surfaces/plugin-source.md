# Plugin source

The plugin source is a tracked plugin's text, and compile builds the plugin from it ([ADR-0006](../../adr/0006-a-tracked-plugins-truth-is-its-source.md)). Track and decompile write it into the mod's working tree, under `plugin-source/`, and I read, diff and edit it as I would any source code. Its layout is a schema Modbench owns, as thin as it can be over Mutagen: Mutagen decides what a record holds, and the schema decides only how the text is laid out. Neither xEdit nor MO2 has a source, so every story is owned here.

## The tree

As a user, I want:

1. To find a record by its file: one folder for each plugin, and one file for each record, named by its EditorID when it has one, then its FormKey.
2. A diff to hold only what changed in the plugin. An insert or a delete touches one record's file, a reorder reads as a reorder, nothing is re-sorted, and decompiling an unchanged plugin changes nothing. *ADR-0006*
3. A record and its child records in one file, so a change to a cell or a quest is one file to review. Child records are never files of their own: Mutagen's serializer numbers them by their place, so a reorder would rename every sibling. *Ruling*
4. Never to edit or merge a value the plugin derives. The masters, the next FormID and the record count are not in the source, so two branches that add records never conflict over them. *ADR-0008; ruling*

## Decompile and compile

As a user, I want:

1. To decompile any plugin in my modlist, whatever tool wrote it and however it bends convention.
2. To trust the source: it says what the plugin means, and compiling it unchanged gives a plugin that means the same, though its bytes may differ. *ADR-0006*
3. To be told, naming the record, when a plugin cannot become source without losing meaning, and never to get a source that quietly lost it. *Never silently wrong*
4. To take a new upstream version into my edits myself: decompile it onto the mod's `main`, then merge my branch with git, where each conflict lands in one record's file. *ADR-0007*

## Changes outside Modbench

The source is files, and any tool can change them. As a user, I want:

1. A change made outside Modbench to compile like any other: a deleted file deletes its record, and an added file adds one. *ADR-0003*
2. A file compile cannot read, or two files that claim one FormKey, to stop compile, naming the files, so a broken change never becomes a broken plugin. *Never silently wrong*
3. A record file in the wrong place to compile, with a warning naming where it belongs. Modbench's next write to that record moves it there. *Never silently wrong*
