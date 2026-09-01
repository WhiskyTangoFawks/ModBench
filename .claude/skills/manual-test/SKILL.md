---
name: manual-test
description: Build the extension and launch a VS Code Extension Development Host against a real MO2 instance for manual, end-to-end testing.
---

# Manual Test

Build the extension if needed, then launch a VS Code Extension Development Host pointed at
a real MO2 instance directory. Do all steps proactively without waiting to be asked.

The extension spawns the backend itself at activation
([ADR-0022](../../../docs/adr/0022-extension-owns-backend-lifecycle.md); there is no Launch/Close
mEdit command — maintainer ruling 2026-09-01) — no manual `dotnet run` step. Setup and prerequisites: [README.md](../../../README.md) § Getting started.

## 0 — Confirm the checkout is current

```bash
git symbolic-ref -q HEAD && git merge-base --is-ancestor main HEAD && echo current
```

Both must hold — HEAD on a branch (a detached HEAD silently strands every commit made on
it) and that branch containing `main`. Anything else: stop and say so — a manual test on a
stale tree verifies behavior `main` no longer has.

## 1 — Build the extension (if needed)

```bash
cd modbench && npm run build
```

The published self-contained backend binary lives at `modbench/backend/` (produced by
`npm run build:backend`, part of `vscode:prepublish`) — rebuild it only if `MEditService/`
changed.

## 2 — Launch the VS Code Extension Development Host

F5 doesn't reliably work in this environment — use the CLI directly:

```bash
code --extensionDevelopmentPath="$(git rev-parse --show-toplevel)/modbench" \
     "$(git rev-parse --show-toplevel)/DevList" &
```

**The workspace root must be a real MO2 instance directory** (`modbench/CLAUDE.md` § Invariants:
workspace root = MO2 instance, no separate setting). Default to `DevList/` (the local test
instance checked into this repo) unless the user names another instance. Do not open the
Modbench source repo itself as the workspace — the Loadout view will have nothing to show.

## 3 — Activate the extension

`activationEvents` is intentionally `[]` — the extension does not auto-activate on startup
(see `src/test/integration/extension.test.ts`). The loadout views (Mods, Plugins, Downloads)
are contributed unconditionally, but activation is still required to populate them.

Force activation once per sitting by running any Modbench command from the Command Palette,
e.g. **Modbench: Refresh**. The activity bar icon then appears (Loadout view) and the
backend launches automatically — the Plugins tree's rows
gain chevrons once the load order is ready. Nothing switches views; every loadout view stays
exactly where it was.
