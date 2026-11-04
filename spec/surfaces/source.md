# Source

A source mod's folder is a mod in Mods ([mods.md](mods.md), A source mod). Its source is here. I build it from here, never from the mod's row.

Each story cites what decides it. A story that cites nothing is owned here.

## Plugin source

The plugin source is a compiled plugin's text, and compile builds the plugin from it ([ADR-0006](../adr/0006-a-compiled-plugins-truth-is-its-plugin-source.md)). Version in git, and decompile, write it into the source folder ([ADR-0007](../adr/0007-plugin-edits-are-git-working-tree-changes.md)), under `plugin-source/`, and I read, diff and edit it as I would any source code. Its layout is Modbench's schema: Mutagen's serialization gives the structure, and Modbench changes it where the stories below need. Mutagen decides what a record holds; Modbench decides where the text departs from Mutagen's.

### The tree

As a user, I want:

1. To find a record by its file: one folder for each plugin, and one file for each record, named by its EditorID when it has one, then its FormKey, except a child record (story 3).
2. A diff to hold only what changed in the plugin. An insert or a delete touches one record's file, and an insert also moves the Next Object ID in the plugin header's file. A reorder reads as a reorder, nothing is re-sorted, and decompiling an unchanged plugin changes nothing. Cites: ADR-0006
3. A record and its child records in one file, so a change to a cell or a quest is one file to review. A worldspace's grid cells are each a file of their own. Cites: ADR-0020
4. Never to edit or merge a value the plugin derives, in the header or in a record: it is not in the source, so branches never conflict over it. The masters and the record count are such values. The Next Object ID is in the source, as Mutagen holds it, so two branches that add records both move it in the header. Cites: ADR-0008; Mutagen's data; ruling

### Decompile and compile

As a user, I want:

1. To decompile any plugin in my modlist, whatever tool wrote it and however it bends convention.
2. To trust the source: it says what the plugin means, and compiling it unchanged gives a plugin that means the same. Cites: ADR-0006
3. To be told when a plugin cannot become source without losing meaning, and never to get a source that quietly lost it. The refusal names the record, and says whether the plugin is malformed or Mutagen mishandles it, because the remedy differs. Cites: Never silently wrong; GLOSSARY.md, Malformed plugin
4. To take the author's new release into my edits myself, with git, where each conflict lands in one record's file. Cites: ADR-0007; GLOSSARY.md, Vendored workflow

### Decompile and repair

As a user, I want:

1. To run Decompile and repair on a malformed plugin from its Problems entry, as well as from its menu in Plugins. Cites: GLOSSARY.md, Malformed plugin; plugins.md, Menus and keys
2. A plugin with a diagnosis no repair answers refused, naming each one. Cites: Refuse, do not repair
3. The repair to land as two commits in the mod's plugin source: the plugin as it was, each malformed record a placeholder naming its diagnosis, then the repair, so the history shows the repair changed only those records. Cites: ADR-0006; ADR-0007; principles.md, Mutagen's data
4. When the mod is not a source mod, the repair makes it one, asking which repository as version in git does, and decompiles the mod's other plugins with it. Cites: plugins.md, Version in git, story 1
5. One confirmation, as decompile asks it (plugins.md, Decompile). Cites: Confirm what destroys

### Changes outside Modbench

The source is files, and any tool can change them. As a user, I want:

1. A change made outside Modbench to compile like any other: a deleted file deletes its record, and an added file adds one. Cites: ADR-0003
2. Compile to stop on a file it cannot read, on a file that holds what no plugin can carry, and on two files that claim one FormKey, naming every such file and the field at fault where there is one, so a broken change never becomes a broken plugin. Spacing and key order alone change no meaning. Cites: Never silently wrong; ADR-0006
3. A record file in the wrong place to compile, with a warning naming where it belongs. Modbench's next write to that record moves it there. Cites: Never silently wrong

### In the text editor

A FormKey is a record's symbol ([symbols.md](symbols.md)). Inside a FormKey, the plugin's name is the plugin's symbol. The gestures are VS Code's own, under VS Code's names and keys: Go to Definition and Go to Symbol are entry points to `open`, Find All References to `referenced by`, and Rename Symbol to `edit field` on the FormKey, or to the plugin's `rename` on its name (commands.md, Entry points are not gestures).

As a user, I want:

1. Go to Definition on a FormKey to open the record, as Opening in [editor.md](editor.md) opens a record given without a plugin. Cites: VS Code; xEdit Ctrl + click
2. Find All References on a FormKey to list every record that references it, one entry for each plugin's copy, in the peek and in the References view. Cites: VS Code; [editor-referenced-by.md](editor-referenced-by.md), The tree, stories 2 to 4
3. Hovering a FormKey to show `EditorID [FormKey]`, the record type, and the plugin whose copy wins. Cites: xedit.md, divergence 10
4. Go to Symbol in Workspace to find a record by EditorID or FormKey across every compiled plugin, and to open it. Cites: VS Code; catalog `open` with no Argument
5. Completion inside a reference field to offer records by EditorID and insert the FormKey, and inside an enum field to offer its values. Cites: VS Code; ADR-0001
6. The Problems panel to carry, on the plugin source of every compiled plugin, active or not, each refusal and warning compile would give that file, and a reference to a record that neither its plugin nor an active plugin holds. A problem appears as I type and clears the same way (ADR-0001). When mEdit cannot answer, the problems stay, and the language status says so, as common, States, story 6 says of a view. Cites: Changes outside Modbench, stories 2 and 3; ADR-0015; ADR-0012; common, States, story 6; ADR-0019; VS Code's language status
7. Rename Symbol on a FormKey to change it, each reference following (symbols.md, The features, story 6). Cites: xEdit's Change FormID
8. A language feature that fails to answer as any language server's feature does. Cites: VS Code; common.md, Reporting

## Menus and keys

| Where | Items, in order |
|---|---|
| Explorer menu, on a source mod's source folder and on its build file | build |
| Editor title, on a source mod's build file | the run button: build |
| Explorer menu, on the manifest in a source mod's source folder | update manifest |

## Build

As a user, I want:

1. Build to write the mod folder from its source folder by running its build file's steps in order. Cites: catalog `build`; ADR-0027
2. A pack step to take the loose files it packs out of the mod folder, so the game reads one copy.
3. Build to record what it made in the mod's manifest, down to each file's bytes, so a build that comes out differently, here or after a clone, shows in Source Control as a change I review, and one that comes out the same changes nothing. A file a task makes or changes is recorded by its path alone, since a tool's output follows the tool, and is not checked. Cites: ADR-0022; ADR-0027; Existing tools; Never silently wrong
4. A source mod's folder renamed outside Modbench to build where it is. Cites: ADR-0022; ADR-0003
5. Build to save the mod's unsaved plugin source and build file first, without asking, as Run Build Task saves before it builds, so the plugins are built from what I see. A file VS Code does not save refuses build, naming it. Cites: VS Code's save before run; ADR-0001; Never silently wrong
6. A notification when it lands, pointing at the Problems panel when it left diagnostics. The diagnostics sit on the plugin source files.
7. From the palette with no mod, a pick of every source mod, one with no folder yet included, so a clone builds its mods back. Cites: commands.md, The entry point supplies what it knows
8. A plugin whose header flag limits its FormIDs, light or medium, refused when its records fall outside that range, naming the records, what limits the plugin, and what lifts that limit. The step's other plugins compile, and the refused plugin is left as it was.
9. A plugin whose plugin source is unreadable refused the same way, naming it and pointing at decompile. Cites: Never silently wrong
10. An interrupted build to leave each file old or new, and none to read as changed outside Modbench. A localized plugin can be left with its strings written without its binary. Building again fixes it.
11. A patcher to be a source mod whose step runs its patching script on my load order, the script from its repository or an installation file. Its output joins the load order, so the next patcher reads it there.
12. Source mods built in mod order, the winning mod last, when build or restore builds more than one, so a patcher reads every mod before it, the patchers before it included.
13. A step to run an external tool, such as a texture optimiser, by the label of a task in my VS Code user tasks. The step holds the tool's arguments. The task holds only where the tool is on my machine and how it runs there, under Proton on Linux. A build whose tool this machine has no task for refused, naming the tool and its page, with Open User Tasks. Cites: Existing tools; VS Code's tasks; instance-repository.md, The repository, story 3
14. Build as a task, so my chain builds before it deploys or publishes. Cites: commands.md, A task is an entry point for a chain
15. A build from uncommitted or unpushed changes to land, with a warning that a clone does not rebuild it. Cites: Respect the user; Never silently wrong
16. A step to be a built-in step, a task, or a Modbench script, a default one or one from the source folder, so what goes in the mod is only what my build file says. Cites: Respect the user; scripts.md, Default scripts
17. A decompile step to replace plugin source without asking, sending what it replaces to the trash. Cites: commands.md, Confirm what destroys
18. A failed step to stop its mod's build, so no step runs on what it left. Cites: Never silently wrong
19. A script step to run its script with my window's Python, in a terminal, as a task Modbench makes and I never pick from Run Task. Cites: scripts.md, Running a Modbench script, stories 1–3
20. Build to make the folder hold its output, its manifest, the files its manifest ignores and the mod manager's files, and nothing else, sending each file it replaces or removes to the trash. Cites: ADR-0027; commands.md, Confirm what destroys

## The build file

As a user, I want:

1. A build file checked against its schema as I type, with completion and each value's meaning on hover, as VS Code checks any JSON file with a schema. Cites: Existing tools; formats/build-file.md
