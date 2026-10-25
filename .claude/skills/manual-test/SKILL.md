---
name: manual-test
description: Build the extension and launch a VS Code Extension Development Host against a real MO2 instance for manual, end-to-end testing.
---

# Manual Test

Build the extension if needed, then launch a VS Code Extension Development Host pointed at a real MO2 instance directory. Do all steps proactively without waiting to be asked.

The extension spawns the backend itself at activation ([ADR-0002](../../../spec/adr/0002-mod-management-and-editing-are-one-tool.md); there is no Launch/Close mEdit command) — no manual `dotnet run` step. Setup and prerequisites: [README.md](../../../README.md) § Setup.

## 0 — Confirm the checkout is current

```bash
git symbolic-ref -q HEAD && git merge-base --is-ancestor main HEAD && echo current
```

Both must hold — HEAD on a branch (a detached HEAD silently strands every commit made on it) and that branch containing `main`. Anything else: stop and say so — a manual test on a stale tree verifies behavior absent from `main`.

## 1 — Build the extension (if needed)

```bash
cd modbench && bash ../.claude/skills/validate/slot-run.sh npm run build
```

The published self-contained backend binary lives at `modbench/backend/` (produced by `npm run build:backend`). Rebuild it when this lists a file. A merge writes the files it changes, so mtime catches a merged branch whose commits predate the build, which `git log --since` misses:

```bash
find MEditService \( -name bin -o -name obj -o -name '*Tests*' \) -prune -o \( -name '*.cs' -o -name '*.csproj' -o -name '*.props' \) -newer modbench/backend/MEditService.Http.dll -print
```

## 2 — Launch the VS Code Extension Development Host

```bash
code --extensionDevelopmentPath="$(git rev-parse --show-toplevel)/modbench" \
     "$(git rev-parse --show-toplevel)/DevListFallout" &
```

A folder the window opens must be a real MO2 instance directory (CONTRIBUTING.md § Launch the extension). Default to `DevListFallout/` (CONTRIBUTING.md § Local folders) unless the user names another instance. Do not open the Modbench source repo itself as the workspace — the Toolbox will have nothing to show.

Run one Extension Development Host per MO2 instance at a time: a worktree isolates the tree, not the runtime.

## 3 — Activate the extension

The extension activates on `onStartupFinished`, so the views populate once the window is ready. The activity bar icon appears (Toolbox), and the backend launches automatically — the Plugins tree's rows gain chevrons once the load order is ready. Nothing switches views; every MO2-side view stays exactly where it was.
