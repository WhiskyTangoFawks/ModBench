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
npm run test:integration  # real VS Code process (~10s), no backend
npm run generate-api      # regen typed API client — needs fresh backend; see /regenerate-api
```

- `/validate` — run at end of every task; wraps gates above.
- `/mutation-test` — mutation testing, `MEditService.Core` only.
- `/manual-test` — e2e test against real MO2 instance.

## Rules that matter

- Generalize across Bethesda games, don't lock to FO4 — FO4-concrete repo
  path/tests are a fixture choice, not a platform lock; each bounded context enforces
  this independently.
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
- New end-to-end command = 4 touch points, else half-wired: backend endpoint +
  `/regenerate-api` → frontend (`PluginRepository`/`SessionController`) →
  `package.json` commands/menus + `extension.ts` registration → `EXPECTED_COMMANDS` in
  integration test.
- Read `/tdd` before planning any implementation breakdown — always, even if it
  won't end up as literal red/green slices.
- Solving pre-existing problems found along the way is in scope — not scope creep.
- If a change contradicts an ADR (`docs/adr/`), say so — don't silently override.
- Numbered milestone titles = priority-ordered epics; unnumbered = speculative,
  sorts last. No `ROADMAP.md` — milestones are it; no due-date/release semantics.
  Tracker/triage/domain conventions: `docs/agents/issue-tracker.md`,
  `docs/agents/triage-labels.md`, `docs/agents/domain.md`.
