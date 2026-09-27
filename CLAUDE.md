# Modbench and mEdit

Modding IDE for Bethesda plugins: VS Code extension (`modbench/`) + local C# service
(`MEditService/`). Architecture and surface map: [README.md](README.md). Per-module invariants:
[modbench/CLAUDE.md](modbench/CLAUDE.md), [MEditService/CLAUDE.md](MEditService/CLAUDE.md).

## Status: pre-alpha, unreleased, zero users

**No backwards compatibility** — no migrations (re-Track is the migration), no shims, no "existing users" reasoning, no deprecation periods. Rename and delete freely; when an old form has no live consumer, remove it and its tests.

## Tools

```bash
# from MEditService/
dotnet format --verify-no-changes   # style gate
dotnet build -v minimal
dotnet test -v minimal

# from modbench/
npm run lint              # errors fail the build; warnings don't — see eslint.config.mjs
npm run build             # type-check + bundle extension + webview
npm run test:unit         # Vitest, no backend
npm run test:integration  # real VS Code process (~10s), no backend
npm run generate-api      # regen api.ts from a backend you run on :5172; agents use /regenerate-api
npm run package           # build alpha .vsix — pinned local @vscode/vsce, no npx
```

## Resources
- `docs/architecture/` is the spec. `target-architecture.md` says how to read the diagrams; a view's spec is its surface in `surfaces/`; a gesture's contract is the trace its row in `commands.md` names.
- `docs/adr/` holds the decisions the code only cites. `ls docs/adr` is the index and the file names are the titles; `grep -rn ADR-00nn` finds everything one governs. Read one when a comment, spec or CLAUDE.md line names it, and when a design looks wrong and you are about to route around it.
- `references/` = grep-only local clones, never modified. Load-bearing two: Mutagen
  (`docs/Big-Cheat-Sheet.md`) and TES5Edit (`wbDefinitionsFO4.pas`: `wbArrayS` = sorted,  `wbArray` = unsorted); also `modorganizer/` (MO2 C++), `SFRecordCompareEngine/`, `vscode-docs`. Gitignored, so **absent from every `git worktree`** — read it at the main checkout's absolute path; a relative grep from a worktree silently matches nothing.

## The chain of authority

principle > ADR > spec (`docs/architecture/`) > code. The higher level wins. An epic or ticket sets
scope, never behaviour. The divergence registers in `docs/out-of-scope/` rank with the ADR each
serves; check them before proposing a feature.

@docs/principles.md

- Strategy is the maintainer's; tactics are yours. Code that disagrees with a document is a defect:
  fix it. Everything the list below does not name is tactical: decide it, and give the reason in
  the commit message.
- Stop and ask when the work adds or changes a gesture, an entry point, or a state, row or status a
  view shows that no spec draws; needs a module, arrow or port `docs/architecture/` does not draw,
  or an interface item a box's caption does not list; or meets two documents at one level that
  disagree.
- Report every break: two documents in the chain that disagree about the work. Build to the higher
  one. A break report and a stop quote the texts at stake, name their levels and say what you
  built; the maintainer decides every change to their documents.
- CONTEXT.md is the maintainer's modding vocabulary, outside the chain. Use its words, or the
  reference tool's. A concept with neither is described, never named: when it needs a name, ask the
  maintainer whether it has one and what it is.

## Rules that matter
- Generalize across Bethesda games. Each bounded context's scan holds the game-name literals and namespaces; what no scan can hold is a design that assumes one game's shape, so an FO4-concrete path or fixture is a fixture choice and never a platform lock.
- Generalize across mod managers. The game owns the format of `plugins.txt`. The mod manager owns the rest. MO2 is one implementation behind the Instance adapter. A scan holds the names. No scan can catch a design that assumes MO2's shape.
- A plugin is `(origin, filename)` on every seam, payload, map key, tree row and temp path (ADR-0012 invariant 1). Keyed on the filename alone, two plugins that share a filename collapse into one and nothing fails. The backend scan sees only a public `string` member named `…plugin` with no `…origin` beside it; map keys, return values and all of modbench go unchecked.
- Detection of an external change is gated; recovery is not. Anything that holds disk-derived state recovers when a file changed without Modbench's knowledge (ADR-0003).
