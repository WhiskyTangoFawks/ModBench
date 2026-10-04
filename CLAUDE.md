# Modbench and mEdit

Modding IDE for Bethesda plugins: VS Code extension (`modbench/`) + local C# service (`MEditService/`). Architecture and surface map: [README.md](README.md). Per-module invariants: [modbench/CLAUDE.md](modbench/CLAUDE.md), [MEditService/CLAUDE.md](MEditService/CLAUDE.md).

## Status: pre-alpha, unreleased, zero users

No backwards compatibility: no migrations, no shims, no "existing users" reasoning, no deprecation periods. Rename and delete freely. When an old form has no live consumer, remove it and its tests.

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
- `docs/architecture/` is the spec. `target-architecture.md` says how to read the diagrams. A view's spec is its surface in `surfaces/`. A trace in `traces/` is a diagram of how data flows, and holds no contract.
- `docs/adr/` holds the decisions the code only cites. `ls docs/adr` is the index and the file names are the titles; `grep -rn ADR-00nn` finds everything one governs. Read one when a comment, spec or CLAUDE.md line names it, and when a design looks wrong and you are about to route around it.
- `references/` = grep-only local clones, never modified. Load-bearing two: Mutagen (`docs/Big-Cheat-Sheet.md`) and TES5Edit (`wbDefinitionsFO4.pas`: `wbArrayS` = sorted,  `wbArray` = unsorted); also `modorganizer/` (MO2 C++), `SFRecordCompareEngine/`, `vscode-docs`. Gitignored, so absent from every `git worktree`: read it at the main checkout's absolute path; a relative grep from a worktree silently matches nothing.

## The chain of authority

principle > ADR > spec (`docs/architecture/`) > code. The higher level wins. An epic or ticket sets scope, never behaviour. The divergence registers in `docs/out-of-scope/` rank with the ADR each serves. Check them before you propose a feature.

@docs/principles.md

- Strategy is the maintainer's; tactics are yours. Code that disagrees with a document is a defect: fix it. Everything the list below does not name is tactical: decide it, and give the reason in the commit message.
- Stop and ask when the work does one of these:
  - It adds or changes a gesture, an entry point, or a state, row or status that a view shows and no spec draws.
  - It needs a module or port that `docs/architecture/` does not draw, other than a band's lib.
  - It needs a reference that `layers.d2` forbids.
  - It adds a public member that exposes what its box's caption hides, or does what another box owns.
  - It meets two documents at one level that disagree.
- A copy of another box's code is never the way around a stop; ADR-0014 rejects it.
- Report every break: two documents in the chain that disagree about the work. Build to the higher one. A break report and a stop quote the texts at stake, name their levels and say what you built; the maintainer decides every change to their documents.
- CONTEXT.md is the maintainer's modding vocabulary, outside the chain. Spec prose, code and identifiers use its words. A label the user sees uses the reference tool's word. A divergence can make that word mislead, such as "top" in a view whose sort the user can reverse. The label then uses another word, and the register records that divergence. A concept with no word in either is described, never named. When it needs a name, ask the maintainer.

## Rules that matter
- Generalize across Bethesda games. Modbench's scan holds the game-name literals, and mEdit's holds game namespaces and game-concrete type names; what no scan can hold is a design that assumes one game's shape, so an FO4-concrete path or fixture is a fixture choice and never a platform lock.
- Generalize across mod managers. The game owns the format of `plugins.txt`. The mod manager owns the rest. MO2 is one implementation behind the Instance adapter. A scan holds the names. No scan can catch a design that assumes MO2's shape.
- A plugin is `(origin, filename)` on every seam, payload, map key, tree row and temp path (ADR-0012). Keyed on the filename alone, two plugins that share a filename collapse into one and nothing fails. The backend scan sees only a public `string` member named `…plugin` with no `…origin` beside it; map keys, return values and all of modbench go unchecked.
- Detection of an external change is gated; recovery is not. Anything that holds disk-derived state recovers when a file changed without Modbench's knowledge (ADR-0003).
