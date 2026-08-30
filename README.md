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

The decisions behind this are [ADR-0041](docs/adr/0041-manual-git-tracking-compile-from-text.md)
and [ADR-0042](docs/adr/0042-plugin-is-the-source-of-truth-lossless-source.md).

## What works today

| Surface | Spec | State |
|---|---|---|
| **Mods** — install from archive, separators, drag-order, enable, deploy (hardlinks), purge, profiles | [mods.md](docs/specs/mods.md) | Implemented |
| **Plugins** — `plugins.txt` order and checkboxes, and with an mEdit load order running, every plugin expands into its record types, records, worldspace/cell tree | [plugins.md](docs/specs/plugins.md) | Implemented |
| **Record editor** — xEdit-style compare grid across the whole load order, conflict coloring (ConflictAll/ConflictThis), in-place editing, copy-as-override / new record, VMAD and conditions | [medit-record-editor.md](docs/specs/medit-record-editor.md) | Implemented |
| **Version control** — Track, edit branch, Save & Compile, native SCM integration, external-change handling, crash recovery | [medit-version-control.md](docs/specs/medit-version-control.md) | Implemented |
| **Referenced By** — what points at a record | [medit-referenced-by.md](docs/specs/medit-referenced-by.md) | Implemented |
| **Loadout header** — profile, load order, deployment readout | [loadout-header.md](docs/specs/loadout-header.md) | Implemented |
| **Record filter** — plain `.sql` files against the record index, applied with a Code Lens | [plugins.md](docs/specs/plugins.md) | Implemented |
| **Repair** — byte-level repair of malformed plugins the Creation Kit wouldn't have written | [medit-repair.md](docs/specs/medit-repair.md) | Specced |
| **Downloads** — Nexus `nxm://` handler and queue | [downloads.md](docs/specs/downloads.md) | Specced |

What's next is the [GitHub Milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones)
board: each numbered milestone is an epic in priority order, its issues are the slices.

## Architecture at a glance

```
modbench/          VS Code extension (TypeScript) + React webview for the compare grid
  src/modmanager/    Mod Management — pure TS/Node, reads and writes the MO2 instance in place,
                     never calls the backend
  src/medit/         Editing view — thin client of the backend over a generated typed API
MEditService/      Local C# service (ASP.NET Core minimal API on localhost:5172)
  MEditService.Core/   Mutagen for plugin I/O; DuckDB as an index over per-record JSON documents;
                       the source codec, Track, compile and git layer
  MEditService.Api/    HTTP host, OpenAPI via Swashbuckle
```

Two bounded contexts with an enforced language boundary — **Mod Management** speaks mods, modlists
and files; **Editing** speaks plugins, records and FormKeys — meet at exactly one object: a plugin
file at a physical path. [CONTEXT-MAP.md](CONTEXT-MAP.md) is the map;
[CONTEXT.md](CONTEXT.md) and [modbench/src/modmanager/CONTEXT.md](modbench/src/modmanager/CONTEXT.md)
are the glossaries. The extension spawns and owns the backend for a load order
([ADR-0022](docs/adr/0022-extension-owns-backend-lifecycle.md)); the Loadout side works with no
backend at all.

The UX rules are borrowed, not invented: Mod Management follows MO2, record editing follows xEdit
([ADR-0034](docs/adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)), and every
interaction uses the native VS Code surface that already does the job
([ADR-0027](docs/adr/0027-mo2-surfaces-map-to-native-vscode-views.md)). Decisions live in
[docs/adr/](docs/adr/); numbering gaps are reversed decisions, whose story is in the
*Alternatives rejected* section of whatever replaced them.

## Getting started

Prerequisites: [.NET SDK](https://dotnet.microsoft.com/download) 10.x,
[Node.js](https://nodejs.org/) 20 LTS or later, VS Code, and git on `PATH` (Track needs it).
The backend test suite also wants `python3` on `PATH` — only to hold an index file from a second
process in the two-windows tests (#588), which skip without it.
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

You don't run the backend yourself — the extension spawns it when you open the editor
(`Modbench: Launch mEdit`). For the API on its own: `dotnet run --project MEditService.Api`,
then `http://localhost:5172/swagger`.

**Launch the extension** from the repo root (F5 is unreliable in this environment; use the CLI):

```bash
code --extensionDevelopmentPath="$(pwd)/modbench" "<path to an MO2 instance directory>"
```

The workspace folder you open **is** the MO2 instance — the directory containing
`ModOrganizer.ini`, `mods/` and `profiles/`. There is no separate instance-path setting
([modbench/CLAUDE.md](modbench/CLAUDE.md) § Invariants). Run any Modbench command from the palette
to activate the extension; the Loadout views appear in the activity bar.

Regenerating the typed API client after a backend change: `npm run generate-api` against a
freshly started backend (the `/regenerate-api` skill has the exact sequence).

## Working on it

The repo is set up to be worked on by people and coding agents alike:

- [CLAUDE.md](CLAUDE.md) — the invariants that matter, the tool commands, and the rules
  (game-generic, vocabulary boundary, never assume file ownership, xEdit decides editing UX).
- [docs/specs/](docs/specs/) — one living spec per UI surface, present tense; a spec that lags the
  product is a bug.
- [docs/adr/](docs/adr/) — decisions; [docs/out-of-scope/](docs/out-of-scope/) — the won't-do
  register; [docs/research/xedit-ux-audit.md](docs/research/xedit-ux-audit.md) — required reading
  before touching any record-editing interaction.
- [docs/agents/](docs/agents/) — tracker conventions (GitHub issues and milestones), triage labels,
  and how to consume the domain docs.

The editing backend is agent-friendly by construction: a discoverable OpenAPI surface, typed
request/response for every operation, an index you can query with SQL, and edits that land as git
working-tree changes a human can review before anything touches the binary. Scripts are plain
Python HTTP clients of the same API ([ADR-0024](docs/adr/0024-python-scripts-are-http-clients.md)).

## References

Modbench stands on [Mutagen](https://github.com/Mutagen-Modding/Mutagen) (plugin parsing and
writing), [DuckDB](https://duckdb.org/) (the record index), and 20+ years of
[xEdit](https://github.com/TES5Edit/TES5Edit) UX refinement, and it manages
[Mod Organizer 2](https://github.com/ModOrganizer2/modorganizer) instances in their own format.

Licensed under the GPL — see [LICENSE](LICENSE).
