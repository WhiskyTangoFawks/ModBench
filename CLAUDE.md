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
npm run generate-api      # regen typed API client — needs fresh backend; see /regenerate-api
npm run package           # build alpha .vsix — pinned local @vscode/vsce, no npx
```

## Resources
- `docs/adr/` holds the decisions the code only cites. `ls docs/adr` is the index and the file names are the titles; `grep -rn ADR-00nn` finds everything one governs. Read one when a comment, spec or CLAUDE.md line names it, and when a design looks wrong and you are about to route around it. A change that alters an invariant rewrites its ADR in place, never supersedes-and-keeps.
- `references/` = grep-only local clones, never modified. Load-bearing two: Mutagen
  (`docs/Big-Cheat-Sheet.md`) and TES5Edit (`wbDefinitionsFO4.pas`: `wbArrayS` = sorted,  `wbArray` = unsorted); also `modorganizer/` (MO2 C++), `SFRecordCompareEngine/`, `vscode-docs`. Gitignored, so **absent from every `git worktree`** — read it at the main checkout's absolute path; a relative grep from a worktree silently matches nothing.

## Rules that matter
- Generalize across Bethesda games — FO4-concrete paths/tests are a fixture choice, not a platform lock; each bounded context enforces this independently.
- Never assume exclusive ownership of a file on disk. MO2, xEdit, other tools and the user can create, edit, move or delete any mod file or plugin outside Modbench at any time. Anything that tracks disk-derived state (indexes, hashes, hidden repos, caches) must detect and recover from the file having changed without Modbench's knowledge.
