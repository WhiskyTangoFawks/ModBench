# Modbench

Modbench is a modding IDE for Bethesda games, built on VS Code. It treats a modlist and its mods as source code, with git for history, review and collaboration. With it, you can:

- Roll a modlist back to any earlier state.
- Try a change on a branch, and drop it when it breaks the game.
- Clone a modlist as its manifests, and restore the working modlist from them.
- Review each record a change touches, as a diff, before it reaches the game.
- Keep your edits to another author's mod on top of each new release.
- Let an agent or a script edit records, and review its changes as you review your own.

## Is it for you

Modbench is for a modder who works as a developer works: in an IDE, with git. You need to know git and VS Code, or want to learn them.

Modbench never edits a plugin in place, and [How it works](#how-it-works) says why. For an edit in place, use xEdit.

## How it works

Modbench is VS Code. The editor, the terminal, search, extensions and your agent work on your modlist. Mod management and record editing are one tool, so when you reorder a mod, the record panel follows. The Mods view works as MO2's does, and the record panel as xEdit's does.

Git holds the history. You commit, diff, branch and merge a modlist as you would any project, and you roll back a change that breaks the game.

VS Code edits files, and git stores files. So Modbench works on files, and turns mods and plugins into files git can hold.

### A mod is its manifest

Git does not hold gigabytes of binary files. So the modlist repository records each mod as a manifest: the file the mod was installed from, and each file the mod holds. The profiles and MO2's configuration sit beside the manifests. An upgrade, a new mod or a removed file reads as a change to a manifest.

Update manifest records a mod as it is, and restore from manifest rebuilds the mod from its manifest. Clone a modlist and restore it, and you have a working modlist to develop, as Wabbajack gives a player one to play.

The instance stays MO2's, in MO2's own format. You switch between MO2 and Modbench at any time.

### A plugin is its source

A plugin is one binary file, and git cannot diff it. So Modbench decompiles a mod's plugins into plugin source, one JSON file for each record, in a git repository of the mod's own, and the mod becomes a source mod. Each edit is then a change to one record's file, which you review in Source Control, and a merge conflict lands in one record.

A build writes the plugins from their source, and the game, MO2 and xEdit load what it wrote. Unchanged source builds plugins that mean the same, record for record. Decompile refuses a plugin it cannot round-trip, and names the record at fault. When another tool changes a built plugin, Modbench tells you.

You view any plugin's records, and edit a source mod's. To edit another author's mod, you use the vendored workflow: their releases on `main`, your edits on a branch. When they release a new version, you decompile it onto `main` and merge your branch.

A source mod with a remote is a submodule of the modlist repository. Restoring the modlist builds the mod from its source.

### Scripts and agents

A script reads and writes records, as an xEdit script does. Modbench's backend is an HTTP API, so any language can script it, and Modbench ships a Python API. In a terminal of a Modbench window, `import medit` reaches the instance with nothing to install, and VS Code's Python tools run and debug the script. Each write is a change to a record's file, so you review a script's work in Source Control, as you review your own.

Your agent reaches Modbench through its MCP server. It reads the instance, runs Modbench's gestures and edits plugin source, and its edits land in Source Control too.

## Status

Modbench is alpha. It supports Fallout 4, Skyrim Special Edition and Starfield, on Windows and Linux, with Mod Organizer 2 instances.

What works today:

- Mods: install from a file or a folder, separators, order, enable, and the downloads folder.
- Plugins: plugin order and checkboxes, and each plugin's records in a tree.
- Records: an xEdit-style record panel across the active plugins, with conflict colours, field editing, copy as override, new record, and Referenced By.
- Version control: the modlist repository, source mods, build, and external changes.
- Record filter: a plain `.sql` file run against every record.
- Agents and scripts: an MCP server for your agent, and Python scripts through `import medit`.

Planned, on the [milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones) board:

- Downloads: fetch each file a manifest names, so a clone restores with no manual download. This waits on a Nexus API key.
- Repair of a malformed plugin, so it decompiles.

Not yet planned: Vortex instances, FOMOD installers, creating a new instance, and LOOT sorting.

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

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) says how to build and test Modbench.

## Built on

Modbench stands on [Mutagen](https://github.com/Mutagen-Modding/Mutagen) (plugin parsing and writing), [DuckDB](https://duckdb.org/) (the record index), and 20+ years of [xEdit](https://github.com/TES5Edit/TES5Edit) UX refinement, and it manages [Mod Organizer 2](https://github.com/ModOrganizer2/modorganizer) instances in their own format.

Licensed under the GPL — see [LICENSE](LICENSE).
