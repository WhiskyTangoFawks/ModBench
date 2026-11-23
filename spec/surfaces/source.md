# Source

A built mod's mod source is here ([mods.md](mods.md), A built mod). I build it from here, never from the mod's row.

Each story cites what decides it. A story that cites nothing is owned here.

## Plugin source

The plugin source is a compiled plugin's text, and compile makes the plugin from it ([ADR-0006](../adr/0006-a-compiled-plugins-truth-is-its-plugin-source.md)). Version in git, and decompile, write it into the mod source ([ADR-0007](../adr/0007-plugin-edits-are-git-working-tree-changes.md)), under `plugin-source/`, and I read, diff and edit it as I would any source code. Its format is Spriggit's JSON format ([ADR-0030](../adr/0030-the-plugin-source-is-spriggits-json-format.md)).

### The tree

As a user, I want:

1. To find a record by its path: one folder for each plugin, and one file for each record, named by its EditorID when it has one, then its FormKey. A record that holds files of its own is a folder so named, with its own document in `RecordData.json`, as the plugin header is at the plugin's folder. An embedded child record is in its owner's file (story 3).
2. A diff to hold only what changed in the plugin. An insert or a delete touches one record's file, and decompiling an unchanged plugin changes nothing. Cites: ADR-0006; ADR-0030
3. A cell and the records it holds in one file, so a change to a cell is one file to review. Cites: ADR-0030
4. Never to manage a value the plugin derives, in the header or in a record: the build manages it. Cites: ADR-0008
5. A plugin to decompile to the same text on Windows and Linux. Cites: Windows and Linux alike

### Decompile and compile

As a user, I want:

1. To decompile any plugin in my modlist, whatever tool wrote it and however it bends convention.
2. To trust the source: it says what the plugin means, and compiling it unchanged gives a plugin that means the same. Cites: ADR-0006
3. To be told when a plugin cannot become source without losing meaning, and never to get a source that quietly lost it. The refusal names the record, and says whether the plugin is malformed or Mutagen mishandles it, because the remedy differs. Cites: Never silently wrong; GLOSSARY.md, Malformed plugin
4. To take the author's new release into my edits myself, with git, where each conflict lands in one record's file. Cites: ADR-0007; GLOSSARY.md, Vendored workflow
5. A plugin source of another version of Spriggit's format refused, naming both versions and pointing at Spriggit's upgrade or a fresh decompile. Cites: ADR-0030

### Decompile and repair

As a user, I want:

1. To run Decompile and repair on a malformed plugin from its Problems entry, as well as from its menu in Plugins. Cites: GLOSSARY.md, Malformed plugin; plugins.md, Menus and keys
2. A plugin with a diagnosis no repair answers refused, naming each one. Cites: Refuse, do not repair
3. The repair to land as two commits in the mod's plugin source: the plugin as it was, each malformed record a placeholder naming its diagnosis, then the repair, so the history shows the repair changed only those records. Cites: ADR-0006; ADR-0007; principles.md, Mutagen's data
4. When the mod is not a built mod, the repair makes it one, asking which repository as version in git does, and decompiles the mod's other plugins with it. Cites: plugins.md, Version in git, story 1
5. One confirmation, as decompile asks it (plugins.md, Decompile). Cites: Confirm what destroys

### Changes outside Modbench

The source is files, and any tool can change them. As a user, I want:

1. A change made outside Modbench to compile like any other: a deleted file deletes its record, and an added file adds one. Cites: ADR-0003
2. Compile to stop on a file it cannot read, on a file that holds what no plugin can carry, and on two files that claim one FormKey, naming every such file and the field at fault where there is one, so a broken change never becomes a broken plugin. Spacing and key order alone change no meaning. Cites: Never silently wrong; ADR-0006
3. A record file in the wrong place to compile, with a warning naming where it belongs. Modbench's next write to that record moves it there. Cites: Never silently wrong

### Editing plugin source

Plugin source names symbols, and [symbols.md](symbols.md) says how the language features answer for them.

As a user, I want:

1. The Problems panel to carry, on the plugin source of every compiled plugin, active or not, each refusal and warning compile would give that file, a reference to a record that neither its plugin nor an active plugin holds, and a path field that names no file the game gets or its plugin's mod holds. A path field that no file in the workspace holds is not judged while the game gets files from outside it, and the language status says so. A problem appears as I type and clears the same way (ADR-0001). When mEdit cannot answer, the problems stay, and the language status says so, as common, States, story 6 says of a view. Cites: Changes outside Modbench, stories 2 and 3; ADR-0012; common, States, story 6; ADR-0019; VS Code's language status
2. Completion inside an enum field to offer its values. Cites: VS Code; ADR-0001

## Menus and keys

| Where | Items, in order |
|---|---|
| Explorer menu, on a mod source and on its build file | build |
| Editor title, on a build file | the run button: build |
| Explorer menu, on the manifest in a mod source | update manifest |

## Build

As a user, I want:

1. Build to write the mod folder from its mod source by running its build file's steps in order. Cites: catalog `build`; ADR-0027
2. A pack step to take the loose files it packs out of the mod folder, so the game reads one copy.
3. Build to record what it made in the mod's manifest, down to each file's bytes, so a build that comes out differently, here or after a clone, shows in Source Control as a change I review, and one that comes out the same changes nothing. A file a command step makes or changes is recorded by its path alone, since a tool's output follows the tool, and is not checked. Cites: ADR-0022; ADR-0027; Existing tools; Never silently wrong
4. A built mod's folder renamed outside Modbench to build where it is. Cites: ADR-0022; ADR-0003
5. Build to save the mod's unsaved plugin source and build file first, without asking, as Run Build Task saves before it builds, so the plugins are built from what I see. A file VS Code does not save refuses build, naming it. Cites: VS Code's save before run; ADR-0001; Never silently wrong
6. A notification when it lands, pointing at the Problems panel when it left diagnostics. The diagnostics sit on the plugin source files.
7. From the palette with no mod, a pick of every mod source, one with no mod yet included, so a clone builds its mods back. Cites: commands.md, The entry point supplies what it knows
8. A plugin whose header flag limits its FormIDs, light or medium, refused when its records fall outside that range, naming the records, what limits the plugin, and what lifts that limit. The step's other plugins compile, and the refused plugin is left as it was.
9. A plugin whose plugin source is unreadable refused the same way, naming it and pointing at decompile. Cites: Never silently wrong
10. An interrupted build to leave each file old or new, and none to read as changed outside Modbench. A localized plugin can be left with its strings written without its binary. Building again fixes it.
11. A patcher to be a built mod whose build step runs its patching script on my load order, the script from its repository or an installation file. Its output joins the load order, so the next patcher reads it there.
12. Mods built in mod order, the winning mod last, when build or restore builds more than one, so a patcher reads every mod before it, the patchers before it included.
13. A command step to run any program, such as a texture optimiser or a Modbench script, by its name on my PATH and its arguments, in the mod's folder, so a build file holds no path on my machine. An argument can name a file the mod source holds. Cites: Existing tools; instance-repository.md, The repository, story 3
14. Build as a task, so my chain builds before it deploys or publishes. Cites: commands.md, A task is an entry point for a chain
15. A build from uncommitted or unpushed changes to land, with a warning that a clone does not rebuild it. Cites: Respect the user; Never silently wrong
16. A step to be a built-in step or a command step, so what goes in the mod is only what my build file says. Cites: Respect the user
17. A decompile step to replace plugin source without asking, sending what it replaces to the trash. Cites: commands.md, Confirm what destroys
18. A failed step to stop its mod's build, so no step runs on what it left. Cites: Never silently wrong
19. Retired.
20. Build to make the folder hold its output, its manifest, the files its manifest ignores and the mod manager's files, and nothing else, sending each file it replaces or removes to the trash. Cites: ADR-0027; commands.md, Confirm what destroys
21. A command step's output to go, as it runs, to a file this machine keeps. A failed step's reason, to me and to my agent, names that file. Cites: agent.md, Reporting, story 1; instance-repository.md, The repository, story 2
22. A build I or my agent stop to stop every program its steps started, so none writes to the mod's folder after. Cites: commands.md, A long gesture stops

## The build file

As a user, I want:

1. A build file checked against its schema as I type, with completion and each value's meaning on hover, as VS Code checks any JSON file with a schema. Cites: Existing tools; formats/build-file.md
