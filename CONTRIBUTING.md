# Contributing

[CLAUDE.md](CLAUDE.md) is the entry point, for people and coding agents alike. [spec/](spec/) is the specification the code is built against.

## Prerequisites

- What the README's [Get started](README.md#get-started) names.
- .NET SDK 10.x and Node.js 20 or later.
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

## Build and test

Install the extension's dependencies once with `npm ci` in `modbench/`. [CLAUDE.md](CLAUDE.md) § Tools has the commands to build and test.

## Launch the extension

```bash
code --extensionDevelopmentPath="$(pwd)/modbench" "<path to an MO2 instance directory>"
```

Run it from the repo root. The extension starts the backend itself.

## Local folders

Two kinds of folder at the repo root serve local work. Neither is needed to build or test.

`references/` holds read-only clones of the reference tools' source, to grep. [CLAUDE.md](CLAUDE.md) § Resources says which files in them matter. Clone them once:

```bash
mkdir -p references
for repo in Mutagen-Modding/Mutagen TES5Edit/TES5Edit ModOrganizer2/modorganizer monster-cookie/SFRecordCompareEngine microsoft/vscode-docs; do
  git -C references clone --depth 1 "https://github.com/$repo.git"
done
```

`DevListFallout/`, `DevListSkyrim/` and `DevListStarfield/` are MO2 instances for manual tests: Fallout 4, Skyrim Special Edition and Starfield. The repo holds their synthetic `MB-DEV` mods. It does not hold the game files. Each holds a small modlist: a fixes master over vanilla, a plugin whose masters chain through it, two mods that disagree on vanilla records and share a loose file, a patch over both, and separators, beside edge cases such as a light plugin and a missing master. With no `gamePath` in `ModOrganizer.ini`, Modbench finds the game in Steam. To give an instance its own copy of the game, hardlink the game's `Data` folder into it, then set `gamePath` to the absolute path of `Stock Game Folder`:

```bash
mkdir -p "DevListFallout/Stock Game Folder"
cp -rl "<game folder>/Data" "DevListFallout/Stock Game Folder/"   # cp -r across filesystems
```

## Windows gates from Linux

On a Linux host, the gates also run on Windows, in a VM under Docker. The [windows-vm skill](.claude/skills/windows-vm/SKILL.md) runs it. Turn on virtualization in the host's firmware, then:

```bash
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER"   # log in again before the next line
.claude/skills/windows-vm/vm.sh up
.claude/skills/windows-vm/gates.sh
```
