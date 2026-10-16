# Modbench

A modding IDE for Bethesda games, built inside VS Code. Modbench is a VS Code extension plus a local C# service. It manages a Mod Organizer 2 instance in place — install, order, enable — and it edits the plugins in that instance (`.esp`/`.esm`/`.esl`) record by record, xEdit-style, with git as the review and history model.

Status: alpha. Supports Fallout 4, Skyrim SE and Starfield, on Windows and Linux. What's next is on the [GitHub Milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones) board.

## What's different

Every other plugin editor writes the binary in place and leaves you with `.bak` files. Modbench treats a plugin the way an IDE treats a program:

- Decompile and commit a mod, and it becomes a source mod: every record in its plugins is serialized to plugin source, one JSON file for each record and its child records, committed to a git repo of its own in the `source/` folder beside `mods/`. The serialization is lossless. A build gives back a plugin that means the same, record for record, though its bytes can differ. Decompile verifies this round trip and refuses a plugin it cannot reproduce, rather than mangle it in silence.
- Edit in the record panel and the change lands as an ordinary working-tree edit. VS Code's own Source Control panel is the review surface: diff it, discard it, commit it, branch it, rebase it.
- Build writes the binary from its plugin source when you say so. The build refuses what it can't emit and reports the rest as Problems.
- The plugin stays what every tool sees. The game, MO2 and xEdit load the plugin binary. Build writes it from its plugin source, which is the truth. Modbench never assumes exclusive ownership of any file. When a compiled plugin changes outside Modbench, Modbench tells you, and you decide what to do next.

The UX is borrowed, not invented: mod management follows MO2, record editing follows xEdit, and every interaction uses the VS Code surface that already does the job. [docs/principles.md](docs/principles.md) and [docs/adr/](docs/adr/) hold the reasons.

## What works today

- Mods: install from a file or a folder, separators, drag to order, enable.
- Plugins: `plugins.txt` order and checkboxes. Each active plugin expands into its record types, records and worldspace and cell tree.
- Record editor: an xEdit-style record panel across the active plugins, with conflict colours, in-place editing, copy as override and new record.
- Version control: Git Init Modlist, Update Mod Manifest, Restore Mod from Manifest, Decompile and Commit Mod, Decompile Plugin, Build Mod, VS Code's Source Control panel, and external-change handling.
- Referenced By: what points at a record, in VS Code's References view.
- Record filter: plain `.sql` files against the record index.
- Toolbox: the instance's game and active profile, switch profile, refresh.
- Downloads: the downloads folder as a tree, to install, exclude and delete. `nxm://` downloads are not built.
- Agent: an MCP server, so an agent in VS Code reads the instance, runs its gestures and edits plugin source.
- Scripts: Python files that read and write records through `import medit`.

Planned: byte-level repair of malformed plugins.

## Install

Download the `.vsix` for your platform from the latest [GitHub Release](https://github.com/WhiskyTangoFawks/ModBench/releases), then:

```bash
code --install-extension modbench-<platform>-<version>.vsix
```

You need git, and 7-Zip on `PATH` as `7z`, `7za` or `7zz` to install a mod from a compressed file. Scripts need `python3` (`python` on Windows).

Open an MO2 instance directory as the folder: the directory that holds `ModOrganizer.ini`, `mods/` and `profiles/`. Trust the folder when VS Code asks. Modbench does not run in Restricted Mode, and its views then say "There is no data provider registered".

## Your agent

While an instance is open, Modbench serves an MCP server at `http://127.0.0.1:47200/mcp`. Set `modbench.agent.port` to use another port. Two windows open at once need a port each, so set it per workspace.

For Claude Code:

```bash
claude mcp add --transport http modbench http://127.0.0.1:47200/mcp
```

For VS Code Chat, in `.vscode/mcp.json`:

```json
{ "servers": { "modbench": { "type": "http", "url": "http://127.0.0.1:47200/mcp" } } }
```

The server tells the agent the rest: how to name objects, which job is a file edit, a gesture or a script.

## Scripts

A script is a Python file that reads and writes records, as an xEdit script does. In a terminal of a Modbench window, `import medit` reaches that window's instance with nothing to install. `help(medit)` lists its functions. Each write is a working-tree change in a plugin source, which you review in Source Control.

## Build from source

### Prerequisites

- .NET SDK 10.x, Node.js 20 or later, VS Code and git.
- 7-Zip on `PATH` as `7z`, `7za` or `7zz`. Installing a mod from a compressed file needs it.
- `python3` (`python` on Windows) on `PATH`. The two-windows backend tests need it, and skip without it.

On Ubuntu or Debian:

```bash
sudo apt-get install -y curl git dotnet-sdk-10.0 p7zip-full python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -   # Ubuntu's own nodejs can be older than 20
sudo apt-get install -y nodejs
```

On Windows, turn on Developer Mode, because the tests create symlinks. Then:

```powershell
winget install Git.Git OpenJS.NodeJS.22 Microsoft.DotNet.SDK.10 Python.Python.3.12 7zip.7zip
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser   # npm runs in PowerShell only with this
```

### Build and test

Install the extension's dependencies once with `npm ci` in `modbench/`. [CLAUDE.md](CLAUDE.md) § Tools has the commands to build and test.

### Launch the extension

```bash
code --extensionDevelopmentPath="$(pwd)/modbench" "<path to an MO2 instance directory>"
```

Run it from the repo root. Open an MO2 instance as in [Install](#install). The extension starts the backend itself.

### Local folders

Two kinds of folder at the repo root serve local work. Neither is needed to build or test.

`references/` holds read-only clones of the reference tools' source, to grep. [CLAUDE.md](CLAUDE.md) § Resources says which files in them matter. Clone them once:

```bash
mkdir -p references
for repo in Mutagen-Modding/Mutagen TES5Edit/TES5Edit ModOrganizer2/modorganizer monster-cookie/SFRecordCompareEngine microsoft/vscode-docs; do
  git -C references clone --depth 1 "https://github.com/$repo.git"
done
```

`DevListFallout/`, `DevListSkyrim/` and `DevListStarfield/` are MO2 instances for manual tests: Fallout 4, Skyrim Special Edition and Starfield. The repo holds their synthetic `MB-DEV` mods. It does not hold the game files. With no `gamePath` in `ModOrganizer.ini`, Modbench finds the game in Steam. To give an instance its own copy of the game, hardlink the game's `Data` folder into it, then set `gamePath` to the absolute path of `Stock Game Folder`:

```bash
mkdir -p "DevListFallout/Stock Game Folder"
cp -rl "<game folder>/Data" "DevListFallout/Stock Game Folder/"   # cp -r across filesystems
```

### Windows gates from Linux

On a Linux host, the gates also run on Windows, in a VM under Docker. The [windows-vm skill](.claude/skills/windows-vm/SKILL.md) runs it. Turn on virtualization in the host's firmware, then:

```bash
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER"   # log in again before the next line
.claude/skills/windows-vm/vm.sh up
.claude/skills/windows-vm/gates.sh
```

## Contributing

[CLAUDE.md](CLAUDE.md) is the entry point, for people and coding agents alike. [docs/architecture/](docs/architecture/) is the specification the code is built against.

## Built on

Modbench stands on [Mutagen](https://github.com/Mutagen-Modding/Mutagen) (plugin parsing and writing), [DuckDB](https://duckdb.org/) (the record index), and 20+ years of [xEdit](https://github.com/TES5Edit/TES5Edit) UX refinement, and it manages [Mod Organizer 2](https://github.com/ModOrganizer2/modorganizer) instances in their own format.

Licensed under the GPL — see [LICENSE](LICENSE).
