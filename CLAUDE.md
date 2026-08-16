# Modbench and mEdit

## What this is

Modbench: VS Code extension + local C# service (mEdit) — modding IDE for Bethesda
plugins. Setup/architecture: [README.md](README.md). Per-module invariants:
[modbench/CLAUDE.md](modbench/CLAUDE.md), [MEditService/CLAUDE.md](MEditService/CLAUDE.md).

## Tools

```bash
# from MEditService/
dotnet format --verify-no-changes   # style gate
dotnet build -v minimal
dotnet test -v minimal

# from modbench/
npm run lint
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
- `references/` (not `.references/`) — grep-only local clones, never modify:
  Mutagen (`docs/Big-Cheat-Sheet.md`), TES5Edit (`wbDefinitionsFO4.pas`: `wbArrayS` =
  sorted, `wbArray` = unsorted), `modorganizer/` (MO2 C++, e.g.
  `src/downloadmanager.cpp` for `.meta` semantics), `SFRecordCompareEngine/`
  (UX-parity reference).
  `vscode-docs` for vscode api documentation
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
  and every user arrives already fluent in it, so familiarity outranks local improvement
  ([ADR-0034](docs/adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md),
  [ADR-0019](docs/adr/0019-xedit-unified-tree-model-for-compare-grid.md)). Specifying from
  memory of xEdit instead of from xEdit is what cost #201/#204/#218 — click focuses a cell
  there, it does not edit. Does not apply to Mod Management, which follows MO2. Also does
  not apply to pending-change UX (staging, revert, dirty indicators) — xEdit has no
  pending-change model; the references there are the product's own change-group model
  (ADR-0017/0028) and VS Code/git native idioms (decorations, dirty markers).
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
