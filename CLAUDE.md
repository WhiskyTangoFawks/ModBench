# Modbench and mEdit

## What this is

Modbench: VS Code extension + local C# service (mEdit) — modding IDE for Bethesda
plugins. Setup/architecture: [README.md](README.md). Per-module invariants:
[modbench/CLAUDE.md](modbench/CLAUDE.md), [MEditService/CLAUDE.md](MEditService/CLAUDE.md).

## Status: pre-alpha, unreleased, zero users

Nothing has shipped and nobody has an installed copy. Therefore: **no backwards compatibility,
ever** — no migrations for internal renames or layout changes (re-Track is the migration), no
compatibility shims, no "existing users" reasoning, no deprecation periods. Rename and delete
freely; when an old form has no live consumer, remove it and its tests. ADRs are rewritten in
place, not superseded-and-kept.

## Tools

```bash
# from MEditService/
dotnet format --verify-no-changes   # style gate
dotnet build -v minimal
dotnet test -v minimal

# from modbench/
npm run lint              # binary: --max-warnings 0, so any warning fails it (#340). No baseline-diffing.
npm run build             # type-check + bundle extension + webview
npm run test:unit         # Vitest, no backend
npm run test:integration  # real VS Code process (~10s), no backend; bundles extension.js first (pretest hook)
npm run generate-api      # regen typed API client — needs fresh backend; see /regenerate-api
npm run package           # build alpha .vsix — pinned local @vscode/vsce, no npx/global install
```

- `/validate` — end of every coding task: gates, then self-review; wraps gates above.
  `/validate gates` runs gates alone, for when an independent reviewer follows (`/orchestrate`).
- `/mutation-test` — mutation testing: `MEditService.Core` (backend) and
  `modbench/src/modmanager/` (frontend).
- `/manual-test` — e2e test against real MO2 instance.

## Rules that matter

- Generalize across Bethesda games, don't lock to FO4 — FO4-concrete repo
  path/tests are a fixture choice, not a platform lock; each bounded context enforces this independently.
- Vocabulary boundary is enforced, not stylistic: "mod" forbidden in Editing;
  "record"/"FormKey" absent from Mod Management. Check `CONTEXT-MAP.md` / relevant
  `CONTEXT.md` before naming anything.
- Mod Management (`modbench/src/modmanager/`) never calls the C# backend — pure
  TS/Node. mEdit is the inverse: thin extension-side view; logic lives in
  `MEditService/`, not webview/extension host.
- **Never assume exclusive ownership of a file on disk.** MO2, xEdit, other mod
  managers, and the user directly can create, edit, move, or delete any mod file
  or plugin outside Modbench at any time. Every mechanism that tracks state
  derived from disk (indexes, hashes, hidden repos, caches) must be able to
  detect and recover from that file having changed without Modbench's
  knowledge — never assume the last write Modbench made is still the current
  state.
- `references/` (not `.references/`) — grep-only local clones, never modify. Clone what
  you need; Mutagen and TES5Edit are the load-bearing two:
  Mutagen (`docs/Big-Cheat-Sheet.md`), TES5Edit (`wbDefinitionsFO4.pas`: `wbArrayS` =
  sorted, `wbArray` = unsorted), `modorganizer/` (MO2 C++, e.g.
  `src/downloadmanager.cpp` for `.meta` semantics), `SFRecordCompareEngine/`
  (UX-parity reference), `vscode-docs` for the VS Code API.
  **Gitignored, so it exists only in the main checkout and never in a `git worktree`.**
  From a worktree, read it at the main checkout's absolute path — a relative grep
  there matches nothing and returns success, which reads as "no such convention
  upstream" rather than "you looked in the wrong place".
- New end-to-end command = 4 touch points, else half-wired: backend endpoint +
  `/regenerate-api` → frontend (`PluginRepository`/`SessionController`) →
  `package.json` commands/menus + `extension.ts` registration → `EXPECTED_COMMANDS` in
  integration test.
- **xEdit decides plugin-editing UX; VS Code decides the vehicle.** Before designing
  any record-editing interaction, read how xEdit does it — `docs/research/xedit-ux-audit.md`
  first, then `references/TES5Edit/xEdit/xeMainForm.pas` (`vstView*` handlers),
  `xeMainForm.dfm` (tree options) and `xEdit/EditTips.txt` (its own user-facing UX
  doc). Adopt its answer. Diverge **only** for a genuine platform limitation, never
  because an alternative seems nicer — 25 years of refinement against this exact domain,
  and every user arrives already fluent in it, so familiarity outranks local improvement.
  Baseline, not ceiling: opt-in power-user additions xEdit never had are fine — default
  stays xEdit's, no xEdit gesture redefined (ADR-0034 amendment)
  ([ADR-0034](docs/adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md),
  [ADR-0019](docs/adr/0019-xedit-unified-tree-model-for-compare-grid.md)). Specifying from
  memory of xEdit instead of from xEdit is what cost #201/#204/#218 — click focuses a cell
  there, it does not edit. Does not apply to Mod Management, which follows MO2. Also does
  not apply to tracking/compile/branch UX (review, revert, history, dirty indicators) —
  xEdit has no such model; the references there are the product's own git-native
  working-tree model (ADR-0041) and VS Code/git native idioms (Source Control panel,
  decorations, dirty markers).
- Native-first, webviews included: before designing any interaction, ask "which VS
  Code surface already does this?" and copy its answer — menus, pickers, confirms,
  prompts, trees and clipboard all have one. A webview is justified by what it
  *renders*, never by the chrome around it. Full mapping in
  [modbench/CLAUDE.md](modbench/CLAUDE.md) § Invariants; ADR-0027 is the precedent.
- Read `/tdd` before planning any implementation breakdown — always, even if it
  won't end up as literal red/green slices.
- If a change contradicts an ADR (`docs/adr/`), say so — don't silently override.
- Numbered milestone titles = priority-ordered epics; unnumbered = speculative,
  sorts last. No `ROADMAP.md` — milestones are it; no due-date/release semantics.
  Tracker/triage/domain conventions: `docs/agents/issue-tracker.md`,
  `docs/agents/triage-labels.md`, `docs/agents/domain.md`.
