# Modbench

A modding IDE for Bethesda games, built inside VS Code. Modbench is a VS Code extension plus a local C# service. It manages a Mod Organizer 2 instance in place — install, order, enable — and it edits the plugins in that instance (`.esp`/`.esm`/`.esl`) record by record, xEdit-style, with git as the review and history model.

Status: pre-alpha. Unreleased, no packaged builds, no users yet. Targets Fallout 4 first; the architecture is game-generic (anything [Mutagen](https://github.com/Mutagen-Modding/Mutagen) supports) and nothing is locked to one game.

## What's different

Every other plugin editor writes the binary in place and leaves you with `.bak` files. Modbench treats a plugin the way an IDE treats a program:

- Track a mod, and every record in its plugins is serialized to a per-record JSON source tree inside the mod folder, committed to a git repo that lives right there. The serialization is lossless — compiling it back is byte-identical to the original, and that round trip is verified at Track time, so a plugin that can't be reproduced is refused rather than silently mangled.
- Edit in the compare grid (or from a script, or from an agent) and the change lands as an ordinary working-tree edit. VS Code's own Source Control panel is the review surface: diff it, discard it, commit it, branch it, rebase it.
- Compile writes the binary from the source when you say so. The compiler refuses what it can't emit and reports the rest as Problems.
- The plugin stays what every tool sees. The game, MO2 and xEdit load the plugin binary. Compile writes it from the source, which is the truth (ADR-0007). Modbench never assumes exclusive ownership of any file. When a tracked plugin changes outside Modbench, Modbench tells you, and you decide what to do next.

The decisions behind this are [ADR-0007](docs/adr/0007-plugin-edits-are-git-working-tree-changes.md) and [ADR-0006](docs/adr/0006-a-tracked-plugins-truth-is-its-source.md).

## What works today

| Surface | Spec | State |
|---|---|---|
| Mods — install from archive or folder, separators, drag-order, enable | [mods.md](docs/architecture/surfaces/mods.md) | Implemented; spec rewritten, code catching up |
| Plugins — `plugins.txt` order and checkboxes, and with mEdit running, every active plugin expands into its record types, records, worldspace/cell tree | [plugins.md](docs/architecture/surfaces/plugins.md) | Implemented; spec rewritten, code catching up |
| Record editor — xEdit-style compare grid across the active plugins, conflict coloring (ConflictAll/ConflictThis), in-place editing, copy-as-override / new record, VMAD | [editor.md](docs/architecture/surfaces/editor.md) | Implemented |
| Version control — Track, compile, native SCM integration, external-change handling | [plugins.md](docs/architecture/surfaces/plugins.md), [plugin-source.md](docs/architecture/surfaces/plugin-source.md) | Implemented; spec rewritten, code catching up |
| Referenced By — what points at a record | [editor-referenced-by.md](docs/architecture/surfaces/editor-referenced-by.md) | Implemented |
| Toolbox — the instance at a glance: its game and active profile, switch profile, refresh | [toolbox.md](docs/architecture/surfaces/toolbox.md) | Implemented; spec rewritten, code catching up |
| Record filter — plain `.sql` files against the record index, applied with a Code Lens | [plugins.md](docs/architecture/surfaces/plugins.md) | Implemented |
| Repair — byte-level repair of malformed plugins the Creation Kit wouldn't have written | [#666](https://github.com/WhiskyTangoFawks/ModBench/issues/666) | Planned |
| Downloads — the downloads folder as a tree: install, exclude, delete (`nxm://` downloading not built) | [downloads.md](docs/architecture/surfaces/downloads.md) | Implemented; spec rewritten, code catching up |

What's next is the [GitHub Milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones) board: each numbered milestone is an epic in priority order, its issues are the slices.

## Architecture at a glance

```
modbench/          VS Code extension (TypeScript) + React webview for the compare grid, one
                   composite project per box of docs/architecture/
  src/*.ts, src/medit/  the activation file and its wiring, Modbench's composition root:
                        mEdit's status bar, log and filter code lens
  src/toolbox/       Toolbox view — the instance's profile row, switch profile and refresh
  src/mods/          Mods view — the modlist tree and every mod gesture, never calling the
                     backend
  src/plugins/       Plugins view — the one tree, rows from the instance value and records from
                     the mEdit client, and every plugin gesture (ADR-0017)
  src/downloads/     Downloads view — the downloads/ tree, its row actions and the upgrade pick
  src/editor/        Editor view — the record panel's host, the active record and Referenced By
  src/modlist/       modlist commands — the mods and separators in mod order, and mod sync
  src/pluginsCommands/   plugins commands — enable, disable and move plugins, and plugin sync
  src/instanceCommands/  instance commands — switch profile, put load order, refresh
  src/downloadsCommands/ downloads commands — exclude, include and delete a downloaded file
  src/install/       install — a new mod, or an upgrade over one
  src/deploy/        deploy commands — makes the game see the instance's resolved files (drawn, not built yet)
  src/client/        the mEdit client — one port over the backend's commands, queries,
                     notifications and lifecycle, with an HTTP and an in-memory adapter (ADR-0002)
  src/loadOrderFileCodec/, src/wire/, src/tables/, src/ports/
                     the kernel — the game's plugins.txt codec, the generated API types and
                     webview protocol, the per-release tables, and the report / ask / trash port
  src/instanceLoader/   the Instance loader — the instance value, rebuilt on the adapter's signal
  src/instanceAdapter/  the Instance adapter — the one reader and writer of the instance; MO2's
                        implementation holds its layout, its watch and its file codecs
MEditService/      Local C# service (ASP.NET Core minimal API on localhost:5172), one project
                   per box of docs/architecture/
  MEditService.Http/          the endpoints, the SSE notification adapter, OpenAPI via
                              Swashbuckle, and mEdit's composition root
  MEditService.Commands/      one handler per gesture: edit, create, track, compile, put load order
  MEditService.Queries/       compare, references, children — the only readers of the read model
  MEditService.LoadOrder/     the kernel: every plugin in the instance, and the active plugins
  MEditService.Codec/         the kernel: record text to document and back, and the schema
  MEditService.Ports/         the kernel: the notification port and its payloads
  MEditService.Index/         DuckDB as an index over per-record JSON documents
  MEditService.SourceAdapter/ the per-record source tree and its git layer
  MEditService.PluginAdapter/ Mutagen for plugin I/O
```

Two bounded contexts with an enforced language boundary — Mod Management speaks mods, modlists and files; Editing speaks plugins, records and FormKeys — meet at exactly one object: a plugin file at a physical path. [CONTEXT.md](CONTEXT.md) is the glossary, both contexts in one file. The extension spawns and owns the backend for an instance ([ADR-0002](docs/adr/0002-mod-management-and-editing-are-one-tool.md)). The Mods, Downloads and Toolbox views never call the backend.

The UX rules are borrowed, not invented: Mod Management follows MO2, record editing follows xEdit ([ADR-0018](docs/adr/0018-xedit-is-the-reference-for-record-editing.md)), and every interaction uses the native VS Code surface that already does the job ([principles](docs/principles.md), Mutagen's data, the reference's behaviour, VS Code's interaction). Decisions live in [docs/adr/](docs/adr/); a decision that was reversed is deleted, and the story is in the Alternatives rejected section of whatever replaced it.

## Getting started

Prerequisites: [.NET SDK](https://dotnet.microsoft.com/download) 10.x, [Node.js](https://nodejs.org/) 20 LTS or later, VS Code, git on `PATH` (Track needs it), and 7-Zip on `PATH` as `7z`, `7za` or `7zz` (installing a mod from an archive needs it). The backend test suite also wants `python3` on `PATH` — only to hold an index file from a second process in the two-windows tests, which skip without it. On Ubuntu/Debian: `sudo apt-get install -y dotnet-sdk-10.0 nodejs npm p7zip-full`.

```bash
# backend
cd MEditService
dotnet build MEditService.sln
dotnet test -v minimal

# extension
cd ../modbench
npm ci
npm run build          # type-check + bundle extension and webview
npm run test:unit
```

You don't run the backend yourself — the extension spawns it at activation and hands it the snapshot: every plugin in the instance and what provides it, and the active plugins in load order. For the API on its own: `dotnet run --project MEditService.Http`, then `http://localhost:5172/swagger`.

Launch the extension from the repo root (F5 is unreliable in this environment; use the CLI):

```bash
code --extensionDevelopmentPath="$(pwd)/modbench" "<path to an MO2 instance directory>"
```

The workspace folder you open is the MO2 instance — the directory containing `ModOrganizer.ini`, `mods/` and `profiles/`. There is no separate instance-path setting. The extension activates on `onStartupFinished`, so the Modbench views are in the activity bar as soon as the window is ready — no command is needed to wake it.

Regenerating the typed API client after a backend change: `npm run generate-api` against a freshly started backend (the `/regenerate-api` skill has the exact sequence).

## Working on it

The repo is set up to be worked on by people and coding agents alike:

- [CLAUDE.md](CLAUDE.md) — the tool commands and the rules no gate can express; the module files under `modbench/` and `MEditService/` carry each side's own.
- [docs/architecture/](docs/architecture/) — the specification the code is built against: the target architecture, one surface spec per view, one trace per flow.
- [docs/adr/](docs/adr/) — decisions.
- [docs/out-of-scope/](docs/out-of-scope/) — the divergence registers, one for each reference tool.
- [docs/research/](docs/research/) — audits of MO2 and xEdit, read from their source. They are the evidence behind the registers and commands.md's Template column.
- [docs/agents/](docs/agents/) — tracker conventions (GitHub issues and milestones) and triage labels.

The editing backend is agent-friendly by construction: a discoverable OpenAPI surface, typed request/response for every operation, an index you can query with SQL, and edits that land as git working-tree changes a human can review before anything touches the binary. Scripts, plain HTTP clients of the same API in any language, are planned but not yet built.

## References

Modbench stands on [Mutagen](https://github.com/Mutagen-Modding/Mutagen) (plugin parsing and writing), [DuckDB](https://duckdb.org/) (the record index), and 20+ years of [xEdit](https://github.com/TES5Edit/TES5Edit) UX refinement, and it manages [Mod Organizer 2](https://github.com/ModOrganizer2/modorganizer) instances in their own format.

Licensed under the GPL — see [LICENSE](LICENSE).
