# Modbench and mEdit

VS Code extension (TypeScript, React webviews) + local C# service (ASP.NET Core,
Mutagen, DuckDB) for managing mod loadouts and for viewing/editing/comparing Bethesda
plugin files (`.esp`/`.esm`/`.esl`).

## Product Structure

**Modbench** is the product — the modding IDE, split across two bounded contexts:

- **Mod Management** (Loadout view, implemented; Downloads, planned) — lives entirely
  in the extension (`modbench/src/modmanager/`); never touches the C# backend.
- **Editing** (mEdit view, implemented; Plugins/load-order, planned) — lives in the C#
  backend (`MEditService/`) plus the editor webviews.

Current surface status: [docs/specs/README.md](docs/specs/README.md). Context split
and vocabulary boundary: [CONTEXT-MAP.md](CONTEXT-MAP.md), [CONTEXT.md](CONTEXT.md)
(Editing), [modbench/src/modmanager/CONTEXT.md](modbench/src/modmanager/CONTEXT.md)
(Mod Management) — "mod" is forbidden in Editing, "record"/"FormKey" is absent in Mod
Management; check your context before naming things.

Module-level detail and per-context invariants: [modbench/CLAUDE.md](modbench/CLAUDE.md),
[MEditService/CLAUDE.md](MEditService/CLAUDE.md).

## Key Invariants

- Backend and extension are always started independently by the user; nothing spawns
  the other.
- Modbench must generalize across Bethesda games, not lock to FO4 — each bounded
  context enforces this in its own way (see the sub-project docs linked above).

Rationale: [docs/adr/](docs/adr/).

## References

`Mutagen/`, `TES5Edit/`, and `modorganizer/` are local clones for API/record-definition
and behavioral reference only — grep them, never modify them. Mutagen docs start at
`Mutagen/docs/Big-Cheat-Sheet.md`; TES5Edit's `wbDefinitionsFO4.pas` has FO4 record
defs (`wbArrayS` = sorted, `wbArray` = unsorted); `modorganizer/` is the MO2 C++ source
(reference for matching MO2 behavior — e.g. `src/downloadmanager.cpp` for download
`.meta` state semantics).

## Development Workflow

```bash
# from MEditService/
dotnet build -v minimal && dotnet test -v minimal

# from modbench/
npm run test:unit        # Vitest unit tests (no backend required)
npm run test:integration # integration tests in real VS Code process (~10s, no backend required)
npm run build            # type-check + bundle extension + webview
npm run generate-api     # regenerate src/medit/generated/api.ts — needs a freshly-started backend; see /regenerate-api
```

For manual end-to-end testing against a real MO2 instance, see `/manual-test`.

## Adding a New Command (End-to-End)

1. **Backend** — add the endpoint (shape governed by `MEditService/CLAUDE.md`'s
   Endpoint Invariant); regenerate the API client (`/regenerate-api`).
2. **Frontend logic** — wire through `PluginRepository`/`SessionController` per
   `modbench/CLAUDE.md`'s placement rules.
3. **VS Code wiring** — register in `package.json` under `contributes.commands`; add
   to `contributes.menus["view/item/context"]` with matching `contextValue` if a tree
   action; register the handler in `extension.ts`.
4. **Tests** — unit + integration green; add the command ID to `EXPECTED_COMMANDS`
   (`modbench/CLAUDE.md`).

## Conventions

Run `/validate` at the end of any task.

Solving pre-existing problems is always in scope.

Read the `/tdd` skill before deciding how to break any issue into an implementation
plan — it governs the breakdown decision every time. Where it fits the work, apply
actual TDD red/green slicing (write the test first, confirm it fails, then write the
minimal code to pass, one behavior at a time); not every plan needs to come out as
literal test-first slices (structural, config-only, or docs-only work may not), but
the skill must always be read first regardless.

## Agent skills

### Issue tracker

Work is tracked as GitHub issues via the `gh` CLI: PRDs are per-initiative issues,
implementation issues are vertical slices; durable per-surface specs live in
`docs/specs/`. GitHub **Milestones are used as epics** and are the roadmap (the
milestones tab — there is no `ROADMAP.md`); numbered titles are prioritized,
unnumbered are speculative. External PRs are not a triage surface. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See
`docs/agents/triage-labels.md`.

### Domain docs

Multi-context: `CONTEXT-MAP.md` at the root maps the Editing and Mod Management
contexts to their `CONTEXT.md` glossaries; system-wide ADRs in `docs/adr/`. See
`docs/agents/domain.md`.
