# Modbench

Modbench is a modding IDE for Bethesda games, built on VS Code. It treats a modlist and its mods as source code, with git for history, review and collaboration. With it, you can 

- Decompile and edit Mods.
- Make changes to your modlist.
- Do anything with a mod or modlist that you can do with git. Commit, clone (and rebuild from the manifest), rollback, branch, fork, review, etc.
- Script against plugins in any language.
- Work natively on Windows or Linux

## Is it for you

Modbench is a power tool for an advanced modlist maintainer who wants the functionality and workflows of standard software development tools. You need to know git and VS Code, or at least want to learn them.

## How it works

Modbench is a VS Code extension. The editor, the terminal, search, extensions and your agent all work. Mod management and record editing are one unified tool, so when you reorder a mod, the record panel follows in real time, without reloading. The Mods view works more or less as MO2's does, and the record panel is basically xEdit's comparison grid.

VS Code edits files, and git stores files, neither work natively with binaries. So Modbench works on human readable, decompiled json, unlike most other modding tools which let you directly edit a binary. The first step to editing a plugin is Version in Git, which decompiles the mod's plugins into a git repository. From then on, Modbench treats that source as the mod's source code, and the compiled mod as a build artifact.

### A mod is its manifest

Git does not hold gigabytes of binary files and assets. So the instance repository holds each mod as a manifest of its installed files. The profiles and MO2's modlist configuration sit beside the manifests. An upgrade, a new mod or a removed file reads as a change to a manifest, which git tracks. To change branches, you simply commit any existing changes, git checkout as normal, and restore any changed mods from their manifests.

The instance stays MO2's, in MO2's own format, so you can switch between MO2 and Modbench: close one, then open the other. Nothing Modbench does breaks using the list in MO2.

### A plugin is its source

A plugin is a binary file: git cannot diff it, and VS Code cannot edit it. Modbench shows any plugin's records in a record panel familiar to xEdit users, but to edit a plugin, you decompile it first. Modbench uses Mutagen to decompile a mod's plugins into JSON for editing (similar to Spriggit), in the `source/` folder, alongside `mods/`. The source sits in a git repository of the mod's own, or in the instance repository. Each record edit is then a change to one file, which you review in VS Code's Source Control. A source mod with a git remote becomes a submodule of the instance repository, and restoring the modlist clones it.

A build reconstructs the binary plugin from its source on demand, and places it in the mod's folder in `mods/` as a build artifact.

## Features

### Scripts

Modbench's Mutagen-powered backend has an HTTP API, so unlike xEdit scripts, which are written in xEdit's own Pascal dialect, any language can script Modbench. Modbench ships a Python API for convenience. VS Code's native tools, or any other IDE, run and debug scripts.

### Filtering

The record index is a DuckDB database, so you filter records with SQL queries.

### A modlist is indexed like code

In code, a language server indexes each symbol, such as a function, and every place that names it. That index is what makes Go to Definition, Find All References and Rename Symbol work. Modbench indexes a modlist the same way. Mods, plugins, records and the other modding concepts are its symbols, and the index holds every place a file names one: the mod order, the plugin order, a manifest, a build file, a FormKey in plugin source. So VS Code's language features work on a modlist as they do on code. Find All References on a plugin lists every file that names it. A rename carries every reference, so renaming a mod, a plugin or a record's FormKey never breaks the modlist in silence. A reference that cannot follow, such as one in a plugin with no plugin source, is named in a warning.

### Problems panel

Every unfinished state of the modlist is an entry in VS Code's Problems panel, such as a mod with no manifest, a broken sorting rule or a malformed plugin. One panel says what is left to do before you commit or publish.

### Deploy

Deploy hardlinks the active profile's load order into a deployment folder you pick, similar to Vortex. Setup a VS Code task to launch the game from ModBench, or just run the executable manually.

### External changes

Modbench picks up a change another tool makes, such as MO2, xEdit or a git checkout, through VS Code's file watchers. When another tool changes a plugin a build wrote, Modbench tells you.

### MCP server

The included MCP server gives your agent Modbench's gestures as tools, so agentic workflows work as you expect in VS Code.

## Status

Modbench is an early alpha. It supports Fallout 4, Skyrim Special Edition and Starfield, on Windows and Linux, with Mod Organizer 2 instances. It is designed never to break the instance for MO2, but it has not been tested much on real modlists yet, so try it on a copy of your instance.

What works today:

- Mods: install from a file or a folder, FOMOD installers with their choices, separators, order, enable, and the downloads folder.
- Nexus: log in with your API key, query info and check for updates. A Premium account also downloads a file, and restore downloads each file it misses. This does mean giving Modbench your API key- which Nexus recommends against for anything other than in-development work. It's a temporary workaround, I will be pursuing proper access in the near future, but in the meantime ModBench is open source- you're welcome to see exactly what and how it's handled, and decide for yourself.
- Plugins: plugin order and checkboxes, and each active plugin's records in a tree. The plugin order is checked against the game's sorting rules and LOOT's, with a suggested move. Modbench doesn't supply "autosort" functionality, it relies on the user to maintain their own load order, and just gives suggestions.
- Records: an xEdit-style record panel across the active plugins, with conflict colours, field editing, copy as override, new record, and Referenced By.
- Version control: the instance repository, Version in Git for any mod, source mods and build, and decompile and repair for a malformed plugin.
- Deploy and purge: hardlinks into a deployment folder.
- Language features: Go to Definition, Find All References, hover, completion and rename across the modlist.
- Publishing: Wabbajack's publisher tags on mods, folders and files, and none of Modbench's own files in what it ships.

Planned:

- Archives: a BA2 opened into its files, and archived files in the file conflicts.
- Compatibility with Vortex instances.
- Creating a new instance. Today Modbench only opens an existing one.
- Deltas, as Wabbajack has them: a file you changed by hand, recorded as a binary diff from its package's copy. Today a clone restores each mod from its manifest, and a change ships as a patch.

## Get started

You need VS Code, git and an MO2 instance. Installing a mod from a compressed file needs 7-Zip on `PATH`, as `7z`, `7za` or `7zz`. Scripts need `python3` (`python` on Windows).

Close MO2 while you work in Modbench. MO2 rewrites the mod and plugin order when it launches a program and when it exits, and undoes changes it did not make.

Download the `.vsix` for your platform from the latest [GitHub Release](https://github.com/WhiskyTangoFawks/ModBench/releases), then:

```bash
code --install-extension modbench-<platform>-<version>.vsix
```

VS Code then opens Modbench's walkthrough, which takes you from your instance to your first built plugin.

Report a problem as a [GitHub issue](https://github.com/WhiskyTangoFawks/ModBench/issues). Modbench's log is in the Output panel, under Modbench.

## Guides

- [Workflows: git and modding](docs/wiki/workflows.md)
- [Connect your agent](docs/wiki/agent.md)
- [Deploy on Linux](docs/wiki/deployment-on-linux.md)
- [Write a script](docs/wiki/scripts.md)
- [Filter records](docs/wiki/record-filter.md)

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to build and test Modbench.

## Built on

Modbench stands on [Mutagen](https://github.com/Mutagen-Modding/Mutagen) (plugin parsing and writing), [DuckDB](https://duckdb.org/) (the record index), and 20+ years of [xEdit](https://github.com/TES5Edit/TES5Edit) UX refinement, and it manages [Mod Organizer 2](https://github.com/ModOrganizer2/modorganizer) instances in their own format.

Licensed under the GPL — see [LICENSE](LICENSE).
