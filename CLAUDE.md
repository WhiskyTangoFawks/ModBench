# Modbench and mEdit

Modding IDE for Bethesda plugins: VS Code extension (`modbench/`) + local C# service
(`MEditService/`). Architecture and surface map: [README.md](README.md). Per-module invariants:
[modbench/CLAUDE.md](modbench/CLAUDE.md), [MEditService/CLAUDE.md](MEditService/CLAUDE.md).

## Status: pre-alpha, unreleased, zero users

**No backwards compatibility** — no migrations (re-Track is the migration), no shims, no
"existing users" reasoning, no deprecation periods. Rename and delete freely; when an old form has
no live consumer, remove it and its tests. ADRs are rewritten in place, never superseded-and-kept.

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

## Rules that matter
- Generalize across Bethesda games — FO4-concrete paths/tests are a fixture choice, not a
  platform lock; each bounded context enforces this independently.
- Vocabulary boundary is enforced, not stylistic: "mod" forbidden in Editing; "record"/"FormKey"
  absent from Mod Management. Check `CONTEXT-MAP.md` / the relevant `CONTEXT.md` before naming
  anything.
- Mod Management (`modbench/src/modmanager/`) never calls the C# backend — pure TS/Node. mEdit is
  the inverse: thin extension-side view; logic lives in `MEditService/`.
- **Never assume exclusive ownership of a file on disk.** MO2, xEdit, other tools and the user can
  create, edit, move or delete any mod file or plugin outside Modbench at any time. Anything that
  tracks disk-derived state (indexes, hashes, hidden repos, caches) must detect and recover from
  the file having changed without Modbench's knowledge.
- `references/` = grep-only local clones, never modified. Load-bearing two: Mutagen
  (`docs/Big-Cheat-Sheet.md`) and TES5Edit (`wbDefinitionsFO4.pas`: `wbArrayS` = sorted,
  `wbArray` = unsorted); also `modorganizer/` (MO2 C++), `SFRecordCompareEngine/`, `vscode-docs`.
  Gitignored, so **absent from every `git worktree`** — read it at the main checkout's absolute
  path; a relative grep from a worktree silently matches nothing.

## Comment Discipline
- Clean code is self-evidently what it does. If code needs a comment to explain *what* it's doing,
  that's usually a smell — prefer renaming/restructuring so the code speaks for itself. Reserve
  comments for the non-obvious: *why*, a surprising constraint, a fact the code can't express on
  its own.
- Comments and doc comments describe current behavior only. Never narrate how the code used to
  work — no "previously," "used to," "no longer," "originally." That framing rots the moment the
  next change lands, and nobody comes back to delete it.
- Rationale earns at most a sentence or two inline. If it needs a paragraph, it belongs in a commit
  message or an ADR — link to it, don't inline the narrative.
- Default to shorter. A comment justifying its own length by covering "four separable concerns" is
  a signal the method has four separable concerns, not that the comment is doing its job.

CLAUDE.MD Files are owned by the developer. Any edit to a claude.md developer needs explicit permission,
given for the exact edit to be made.