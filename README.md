# Modbench

**A modding IDE for Bethesda games, built inside VS Code.** Modbench is a VS Code extension plus a
local C# service. It manages a Mod Organizer 2 instance in place — install, order, enable, deploy —
and it edits the plugins in that instance (`.esp`/`.esm`/`.esl`) record by record, xEdit-style,
with git as the review and history model.

**Status: pre-alpha.** Unreleased, no packaged builds, no users yet. Targets Fallout 4 first; the
architecture is game-generic (anything [Mutagen](https://github.com/Mutagen-Modding/Mutagen)
supports) and nothing is locked to one game.

## What's different

Every other plugin editor writes the binary in place and leaves you with `.bak` files. Modbench
treats a plugin the way an IDE treats a program:

- **Track** a mod, and every record in its plugins is serialized to a per-record JSON *source*
  tree inside the mod folder, committed to a git repo that lives right there. The serialization is
  lossless — compiling it back is byte-identical to the original, and that round trip is verified
  at Track time, so a plugin that can't be reproduced is refused rather than silently mangled.
- **Edit** in the compare grid (or from a script, or from an agent) and the change lands as an
  ordinary working-tree edit. VS Code's own Source Control panel is the review surface: diff it,
  discard it, commit it, branch it, rebase it.
- **Save & Compile** writes the binary from the source when you say so. The compiler refuses what 
  it can't emit and reports the rest as Problems.
- **The plugin stays the source of truth.** It's what the game loads and what MO2, xEdit and
  everything else see. Modbench never assumes exclusive ownership of any file — external changes
  are detected and handled through one dialog (upstream update, or your own edit).

The decisions behind this are [ADR-0007](docs/adr/0007-plugin-edits-are-git-working-tree-changes.md)
and [ADR-0006](docs/adr/0006-the-plugin-is-the-source-of-truth.md).

## What works today

| Surface | Spec | State |
|---|---|---|
| **Mods** — install from archive, separators, drag-order, enable, deploy (hardlinks), purge, profiles | [mods.md](docs/specs/mods.md) | Implemented |
| **Plugins** — `plugins.txt` order and checkboxes, and with an mEdit load order running, every plugin expands into its record types, records, worldspace/cell tree | [plugins.md](docs/specs/plugins.md) | Implemented |
| **Record editor** — xEdit-style compare grid across the whole load order, conflict coloring (ConflictAll/ConflictThis), in-place editing, copy-as-override / new record, VMAD | [medit-record-editor.md](docs/specs/medit-record-editor.md) | Implemented |
| **Version control** — Track, edit branch, Save & Compile, native SCM integration, external-change handling, crash recovery | [medit-version-control.md](docs/specs/medit-version-control.md) | Implemented |
| **Referenced By** — what points at a record | [medit-referenced-by.md](docs/specs/medit-referenced-by.md) | Implemented |
| **Toolbox** — the view of the instance and the composition root | [containers.md](docs/specs/containers.md) | Implemented |
| **Record filter** — plain `.sql` files against the record index, applied with a Code Lens | [plugins.md](docs/specs/plugins.md) | Implemented |
| **Repair** — byte-level repair of malformed plugins the Creation Kit wouldn't have written | [medit-repair.md](docs/specs/medit-repair.md) | Specced |
| **Downloads** — Nexus download queue and tree (`nxm://` handler still pending) | [downloads.md](docs/specs/downloads.md) | Implemented |

What's next is the [GitHub Milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones)
board: each numbered milestone is an epic in priority order, its issues are the slices.

## Architecture at a glance

```
modbench/          VS Code extension (TypeScript) + React webview for the compare grid
  src/modmanager/    Mod Management — pure TS/Node, reads and writes the MO2 instance in place,
                     never calls the backend
  src/plugins/       Plugins view — the one tree, rows from the Instance and records from the
                     mEdit client, and every plugin gesture (ADR-0017)
  src/editor/        Editor view — the record panel, its message router, the active record and
                     Referenced By; imports the mEdit client and nothing from the MO2 side
  src/medit/         The mEdit client — one port over the backend's commands, queries,
                     notifications and lifecycle, with an HTTP and an in-memory adapter (ADR-0014)
MEditService/      Local C# service (ASP.NET Core minimal API on localhost:5172), one project
                   per box of docs/architecture/
  MEditService.Http/          the endpoints, the SSE notification adapter, OpenAPI via
                              Swashbuckle, and mEdit's composition root
  MEditService.Watcher/       one watcher per mod folder in the load order
  MEditService.Commands/      one handler per gesture: edit, create, track, compile, put load order
  MEditService.Queries/       compare, references, children — the only readers of the read model
  MEditService.LoadOrder/     the kernel: the load-order snapshot and who wins
  MEditService.Codec/         the kernel: record text to document and back, and the schema
  MEditService.Ports/         the kernel: the notification port and its payloads
  MEditService.Index/         DuckDB as an index over per-record JSON documents
  MEditService.SourceRepo/    the per-record source tree and its git layer
  MEditService.PluginAdapter/ Mutagen for plugin I/O
```

Two bounded contexts with an enforced language boundary — **Mod Management** speaks mods, modlists
and files; **Editing** speaks plugins, records and FormKeys — meet at exactly one object: a plugin
file at a physical path. [CONTEXT.md](CONTEXT.md) is the glossary, both contexts in one file. The extension spawns and owns the backend for a load order
([ADR-0002](docs/adr/0002-mod-management-and-editing-are-one-tool.md)); the MO2 side works with no
backend at all.

The UX rules are borrowed, not invented: Mod Management follows MO2, record editing follows xEdit
([ADR-0018](docs/adr/0018-xedit-is-the-reference-for-record-editing.md)), and every
interaction uses the native VS Code surface that already does the job
([ADR-0017](docs/adr/0017-mo2-is-the-reference-for-mod-management.md)). Decisions live in
[docs/adr/](docs/adr/); a decision that was reversed keeps its number, and the story is in the
*Alternatives rejected* section of whatever replaced it.

## Getting started

Prerequisites: [.NET SDK](https://dotnet.microsoft.com/download) 10.x,
[Node.js](https://nodejs.org/) 20 LTS or later, VS Code, and git on `PATH` (Track needs it).
The backend test suite also wants `python3` on `PATH` — only to hold an index file from a second
process in the two-windows tests, which skip without it.
On Ubuntu/Debian: `sudo apt-get install -y dotnet-sdk-10.0 nodejs npm`.

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

You don't run the backend yourself — the extension spawns it at activation and hands it the
active modlist as the load order. For the API on its own:
`dotnet run --project MEditService.Http`, then `http://localhost:5172/swagger`.

**Launch the extension** from the repo root (F5 is unreliable in this environment; use the CLI):

```bash
code --extensionDevelopmentPath="$(pwd)/modbench" "<path to an MO2 instance directory>"
```

The workspace folder you open **is** the MO2 instance — the directory containing
`ModOrganizer.ini`, `mods/` and `profiles/`. There is no separate instance-path setting. The
extension activates on `onStartupFinished`, so the Modbench views are in the activity bar as soon
as the window is ready — no command is needed to wake it.

Regenerating the typed API client after a backend change: `npm run generate-api` against a
freshly started backend (the `/regenerate-api` skill has the exact sequence).

## Working on it

The repo is set up to be worked on by people and coding agents alike:

- [CLAUDE.md](CLAUDE.md) — the tool commands and the rules no gate can express; the module
  files under `modbench/` and `MEditService/` carry each side's own.
- [docs/specs/](docs/specs/) — one living spec per UI surface, present tense; a spec that lags the
  product is a bug.
- [docs/architecture/](docs/architecture/) — the target architecture: the zoom-out, the reference view, one trace per gesture, and how to read them.
- [docs/adr/](docs/adr/) — decisions; [docs/out-of-scope/](docs/out-of-scope/) — the won't-do
  register; [docs/research/xedit-ux-audit.md](docs/research/xedit-ux-audit.md) — required reading
  before touching any record-editing interaction.
- [docs/agents/](docs/agents/) — tracker conventions (GitHub issues and milestones), triage labels,
  and how to consume the domain docs.

The editing backend is agent-friendly by construction: a discoverable OpenAPI surface, typed
request/response for every operation, an index you can query with SQL, and edits that land as git
working-tree changes a human can review before anything touches the binary. Scripts, plain HTTP
clients of the same API in any language, are planned but not yet built.

## References

Modbench stands on [Mutagen](https://github.com/Mutagen-Modding/Mutagen) (plugin parsing and
writing), [DuckDB](https://duckdb.org/) (the record index), and 20+ years of
[xEdit](https://github.com/TES5Edit/TES5Edit) UX refinement, and it manages
[Mod Organizer 2](https://github.com/ModOrganizer2/modorganizer) instances in their own format.

Licensed under the GPL — see [LICENSE](LICENSE).
