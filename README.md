# Modbench

Modbench is a modding IDE for Bethesda games, built on VS Code. It treats a modlist and its mods as source code, with git for history, review and collaboration. With it, you can:

- Roll a modlist back to any earlier state.
- Try a change on a branch, and drop it when it breaks the game.
- Clone a modlist as its manifests, and restore the working modlist from them.
- Review each record a change touches, as a diff, before it reaches the game.
- Manage multiple contributors working on a single modlist cleanly.
- Keep your edits to another author's mod on top of each new release.
- Script records in any language, and review a script's changes as you review your own.

## Is it for you

Modbench is a power tool for an advanced modlist maintainer who wants the functionality of standard software development tooling. You need to know git and VS Code, or at least want to learn them.

## How it works

Modbench is a VS Code extension. The editor, the terminal, search, extensions and your agent work on your modlist. Mod management and record editing are one unified tool, so when you reorder a mod, the record panel follows. The Mods view works as MO2's does, and the record panel as xEdit's does.

Git holds the history. You commit, diff, branch and merge a modlist as you would any project, and you roll back a change that breaks the game.

VS Code edits files, and git stores files. So Modbench works on files, and turns mods and plugins into files git can hold.

### A mod is its manifest

Git does not hold gigabytes of binary files. So the modlist repository holds each mod as a manifest, which restores the mod as installed. The profiles and MO2's modlist configuration sit beside the manifests. An upgrade, a new mod or a removed file reads as a change to a manifest, which git tracks.

The instance stays MO2's, in MO2's own format. You switch between MO2 and Modbench at any time. Nothing Modbench does breaks using the list in MO2.

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

Modbench is alpha. It supports Fallout 4, Skyrim Special Edition and Starfield, on Windows and Linux, with Mod Organizer 2 instances.

What works today:

- Mods: install from a file or a folder, separators, order, enable, and the downloads folder.
- Plugins: plugin order and checkboxes, and each active plugin's records in a tree.
- Records: an xEdit-style record panel across the active plugins, with conflict colours, field editing, copy as override, new record, and Referenced By.
- Version control: the modlist repository, source mods and build.

Planned, on the [milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones) board:

- Deploy and launch: Modbench does not launch the game yet, so you launch it from MO2.
- Downloads: fetch each file a manifest names, so a clone restores with no file fetched by hand. This waits on a Nexus API key.
- Repair of a malformed plugin, so it decompiles. Mutagen is stricter than xEdit about what it accepts, so not every plugin decompiles today.
- Vortex instances, alongside MO2.
- FOMOD installers.
- Creating a new instance. Today Modbench opens an existing one.
- LOOT integration.
- Including Deltas for changed manually changed files in a comitted modlist, as wabbajack does. In order to fit in a git repo, all files must match the hash of their providing package. This may eventually be implemented through providing the delta as an external download.

## Get started

You need VS Code, git and an MO2 instance. Installing a mod from a compressed file needs 7-Zip on `PATH`, as `7z`, `7za` or `7zz`. Scripts need `python3` (`python` on Windows).

Download the `.vsix` for your platform from the latest [GitHub Release](https://github.com/WhiskyTangoFawks/ModBench/releases), then:

```bash
code --install-extension modbench-<platform>-<version>.vsix
```

VS Code then opens Modbench's walkthrough, which takes you from your instance to your first built plugin.

## Guides

- [Connect your agent](docs/wiki/agent.md)
- [Write a script](docs/wiki/scripts.md)
- [Filter records](docs/wiki/record-filter.md)

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to build and test Modbench.

## Built on

Modbench stands on [Mutagen](https://github.com/Mutagen-Modding/Mutagen) (plugin parsing and writing), [DuckDB](https://duckdb.org/) (the record index), and 20+ years of [xEdit](https://github.com/TES5Edit/TES5Edit) UX refinement, and it manages [Mod Organizer 2](https://github.com/ModOrganizer2/modorganizer) instances in their own format.

Licensed under the GPL — see [LICENSE](LICENSE).
