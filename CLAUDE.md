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
- `docs/adr/` holds the decisions the code only cites. `ls docs/adr` is the index and the file names are the titles; `grep -rn ADR-00nn` finds everything one governs. Read one when a comment, spec or CLAUDE.md line names it, and when a design looks wrong and you are about to route around it.
- `references/` = grep-only local clones, never modified. Load-bearing two: Mutagen
  (`docs/Big-Cheat-Sheet.md`) and TES5Edit (`wbDefinitionsFO4.pas`: `wbArrayS` = sorted,  `wbArray` = unsorted); also `modorganizer/` (MO2 C++), `SFRecordCompareEngine/`, `vscode-docs`. Gitignored, so **absent from every `git worktree`** — read it at the main checkout's absolute path; a relative grep from a worktree silently matches nothing.

## Rules that matter
- Generalize across Bethesda games. Each bounded context's scan holds the game-name literals and namespaces; what no scan can hold is a design that assumes one game's shape, so an FO4-concrete path or fixture is a fixture choice and never a platform lock.
- Generalize across mod managers. The game owns the format of `plugins.txt`. The mod manager owns the rest. MO2 is one implementation behind the Instance adapter. A scan holds the names. No scan can catch a design that assumes MO2's shape.
- A plugin is `(origin, filename)` on every seam, payload, map key, tree row and temp path (ADR-0012 invariant 1). Keyed on the filename alone, two copies of one file collapse into one and nothing fails. The backend scan sees only a public `string` member named `…plugin` with no `…origin` beside it; map keys, return values and all of modbench go unchecked.
- Never assume exclusive ownership of a file on disk (ADR-0003). Detection is gated; recovery is not — anything that holds disk-derived state must recover when a file changed without Modbench's knowledge.
- The specification is the source and the code follows it: `docs/architecture/` (the diagrams,
  surfaces, traces and `commands.md`) and the ADRs say what the code must be, and code that
  disagrees with them is the defect. Never edit a spec to match the code; a spec that looks wrong
  stops and asks the maintainer.
- The target architecture in `docs/architecture/` and every reference list, csproj `ProjectReference` and tsconfig `references`, are the maintainer's. An implementation that needs a module, an arrow, a payload or a public type not drawn there stops and asks; it never adds one.
