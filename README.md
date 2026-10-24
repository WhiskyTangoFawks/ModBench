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

VS Code edits files, and git stores files, neither work natively with binaries. So Modbench works on human readable, decomiled json, unlike most other modding tools which let you directly edit a binary. The first step to editting a plugin is decompilation, which automatically creates a local git repo. Once you have done so, modbench treats that source as the mods source code, and the compiled mod as a build artifact.

### A mod is its manifest

Git does not hold gigabytes of binary files and assets. So the modlist repository holds each mod as a manifest of it's installed files. The profiles and MO2's modlist configuration sit beside the manifests. An upgrade, a new mod or a removed file reads as a change to a manifest, which git tracks. To change branches, you simply commit any existing changes, git checkout as normal, and restore any changed mods from their manifests.

The instance stays MO2's, in MO2's own format, so you can switch between MO2 and Modbench: close one, then open the other. Nothing Modbench does breaks using the list in MO2.

### A plugin is its source

A plugin is a binary file: git cannot diff it, and VS Code cannot edit it. Modbench shows any plugin's records in a record panel familiar to xEdit users, but to edit a plugin, you decompile it first. Modbench uses Mutagen to decompile a mod's plugins into JSON for editing (similar to Spriggit), in a git repository of the mod's own in the `source/` folder, alongside `mods/`. Each record edit is then a change to one file, which you review in VS Code's Source Control. A source mod with a git remote becomes a submodule of the modlist repository, and restoring the modlist clones it.

A build reconstructs the binary plugin from its source on demand, and places it in the mod's folder in `mods/` as a build artifact.

## Features

### Scripts

Modbench's Mutagen-powered backend has an HTTP API, so unlike xEdit scripts, which are written in xEdit's own Pascal dialect, any language can script Modbench. Modbench ships a Python API for convenience. VS Code's native tools, or any other IDE, run and debug scripts.

### Filtering

The record index is a DuckDB database, so you filter records with SQL queries.

### External changes

Modbench picks up a change another tool makes, such as MO2, xEdit or a git checkout, through VS Code's file watchers. When another tool changes a plugin a build wrote, Modbench tells you.

### MCP server

The included MCP server gives your agent Modbench's gestures as tools, so agentic workflows work as you expect in VS Code.

## Status

Modbench is an early alpha. It supports Fallout 4, Skyrim Special Edition and Starfield, on Windows and Linux, with Mod Organizer 2 instances. It is designed never to break the instance for MO2, but it has not been tested much on real modlists yet, so try it on a copy of your instance.

What works today:

- Mods: install from a file or a folder, FOMOD installers with their choices, separators, order, enable, and the downloads folder.
- Plugins: plugin order and checkboxes, and each active plugin's records in a tree.
- Records: an xEdit-style record panel across the active plugins, with conflict colours, field editing, copy as override, new record, and Referenced By.
- Version control: the modlist repository, source mods and build.
- Publishing: Wabbajack's publisher tags on mods, folders and files, and none of Modbench's own files in what it ships.

Planned:

- Deploy and launch: Modbench does not launch the game yet, so you launch it from MO2.
- Downloads: there is no automation of downloads yet, this waits on me asking for a Nexus API key.
- Repair of a malformed plugin, so it decompiles. Mutagen is stricter than xEdit about what it accepts, so not every plugin decompiles today.
- Compatibility with Vortex instances.
- Creating a new instance. Today Modbench only opens an existing one.
- LOOT integration.
- Including Deltas for changed manually changed files in a comitted modlist, as wabbajack does. In order to fit in a git repo, all files must match the hash of their providing package. This may eventually be implemented through providing the delta as an external download.

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
- [Write a script](docs/wiki/scripts.md)
- [Filter records](docs/wiki/record-filter.md)

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to build and test Modbench.

## Built on

Modbench stands on [Mutagen](https://github.com/Mutagen-Modding/Mutagen) (plugin parsing and writing), [DuckDB](https://duckdb.org/) (the record index), and 20+ years of [xEdit](https://github.com/TES5Edit/TES5Edit) UX refinement, and it manages [Mod Organizer 2](https://github.com/ModOrganizer2/modorganizer) instances in their own format.

Licensed under the GPL — see [LICENSE](LICENSE).
