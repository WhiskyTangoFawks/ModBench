# Loadout header — Surface Specification

**Status: Implemented.** Launch… is a placed affordance whose wiring is deferred —
see *Launch…* below. There is no Launch/Close mEdit anywhere: the backend launches with the
extension (maintainer ruling 2026-09-01) — see *mEdit has no lifecycle affordance* below.

A cross-context surface. It reads Mod-Management state (profile, deployment), so it belongs to
neither bounded context and lives at the composition root
([CONTEXT-MAP.md](../../CONTEXT-MAP.md)). It carries no domain vocabulary of its own: it names
*profiles* and a *deployment*, and never records, FormKeys, mods or files.

Siblings: [Mods](mods.md), [Plugins load order](plugins.md), [Downloads](downloads.md),
[mEdit](medit.md).

## Problem Statement

Five view title bars each grew independently as their own features shipped, and roughly half
the icons they accumulated were not about those trees at all. Switch Profile swapped the
modlist *and* `plugins.txt` *and* invalidated any running load order, but sat on the Mods tree
because Mods existed first. Launch mEdit and Close mEdit sat on whichever view happened to be
visible at the time. Refresh was re-invented three times under three command ids for one need.
Deploy, Purge and Launch Game sat on Mods because Mods was the only host. The Mods tree
reached nine navigation icons with nothing in overflow, which VS Code silently collapses into
`…` anyway once the sidebar is narrow.

The obvious home — a container-level `…` shared by every view in the Modbench container — does
not exist. VS Code's menu contribution points are enumerated and there is no
`viewsContainer/title`; what renders at the top of a multi-view container is VS Code's own
auto-generated **Views** menu (show/hide each view, Reset View Locations, Move View), which
exists because the container holds several views and cannot be injected into.

So a shared home has to be a real view.

## Solution

The **Loadout header** — `modbench.loadoutHeader`, pinned first in the Modbench container,
present unconditionally. A small readout whose rows double as commands, and whose title bar is
the home for every workspace-scope action.

It is deliberately *not* a dashboard. It has a hard ceiling of four rows, and a row earns its
place by being state the user needs at a glance while working in the trees below it.

### When there is no loadout

With no workspace open, or a workspace that isn't an MO2 instance, the view registers but
renders **no rows**, and Launch…, Deploy and Purge are withheld from its title bar
(`modbench.workspaceIsMo2Instance`). The commands every row activates are registered alongside
the Loadout views, so on those paths they do not exist — rows would be clicks that throw. The
Mods view's own `viewsWelcome` is what explains the situation to the user; the header
stays quiet rather than repeating it.

### Rows

| Row | Description | Activates |
| --- | --- | --- |
| Profile | active profile name, or `—` when unreadable | Switch Profile |
| Deployment | `deployed` / `not deployed` | Deploy, when not deployed |

- The **Profile** row degrades to `—` and logs rather than erroring: a readout blip is
  ADR-0026's background tier, not a toast.
- The **Deployment** row appears only when Modbench itself is the deployer
  (`modbench.mods.deploymentMode != external`, read through the single `isStandaloneDeployment`
  predicate that also drives the `when` clauses, so a row and an icon can never disagree), and
  reads deployed-ness from the presence of
  the deploy manifest (`mods/.medit-manifest.json`) — the same question purge already asks, so
  the readout cannot disagree with what purge would do. A corrupt manifest reads as deployed:
  there is state out there needing a purge, which is what the row should say. When deployed,
  the row is an inert readout — Purge is destructive and stays in overflow behind a modal.

### mEdit has no lifecycle affordance

The backend launches with the extension (maintainer ruling 2026-09-01: the DB-file-backed
session made startup cheap enough that lifecycle stopped being a user decision); the former
Launch mEdit / Close mEdit toggle on the [Plugins view](plugins.md) is gone. This header
carries no mEdit row of any kind, running or not, and reads no backend/load order state —
`LoadoutHeaderProvider` only ever reads Mod-Management state. (The earlier ruling that placed
the pair — "launch mEdit should be an option on the plugins view" — is superseded by there
being no pair to place.)

### Title bar

| Slot | Action | Gate |
| --- | --- | --- |
| `navigation@1` | Refresh | always |
| `navigation@2` | Launch… | standalone deployment only |
| overflow | Deploy, Purge | standalone deployment only |

**Refresh** is one command id (`modbench.refresh`) that re-reads every Mod-Management source
together — modlist, plugin load order, downloads, active profile. A partial refresh is the
state where the user believes they have resynced and one tree still quietly disagrees. It
remains a safety net for flaky watch events, never the primary path: every one of those
sources is watcher-driven.

There is no reload of the editing backend to offer (ADR-0044): the load order it holds is
reconciled on every loadout change, so Refresh — a re-read of Mod Management's own sources — is
the only re-read gesture, and the backend's picture follows it through the same watchers.

### Launch…

One affordance, regardless of how many executables exist. It fetches the tasks contributed for
the MO2 executables registry at invocation time, presents them in a `showQuickPick`, and
executes the selection. It never resolves a binary itself, and no per-executable command or
icon is ever contributed.

The MO2 executables registry does not contribute tasks yet, so there are none, and Launch…
says so rather than guessing a path. Wiring it to the registry is deferred work.

This supersedes the old standalone **Launch Game**, which conflated three operations —
deploy, spawn a hardcoded `Fallout4.exe`, purge when that process exited. Deploying and
launching are separate operations on the same files and are now separate actions; the
hardcoded executable was a lock to one game that the registry removes by construction; and
teardown-on-exit is deferred to its own design, since a
script-extender loader exits immediately and its exit code says nothing about the game.

## Deltas this surface absorbed

Historical record from before ADR-0035 merged Mod Management's "Plugins (load order)" and
Editing's "mEdit Plugins tree" into the one shared Plugins tree that exists today — the two
"Plugins" rows below describe the two pre-merge views, not two views that exist now.

| View | Lost | Result |
| --- | --- | --- |
| Mods | Switch Profile, Launch mEdit (since removed entirely), Refresh, Deploy, Purge, Launch Game | Filter, sort-direction toggle, Collapse All — **nine icons to three** |
| Plugins (load order) | Refresh | Filter only |
| Downloads | — | Filter gained at slot 1, show-hidden toggle moved to slot 2, Sort by… stays in overflow |
| Plugins (Editing) | Refresh, Close mEdit (since removed entirely) | Name filter, record filter, New Plugin, **Collapse All gained** |

## Implementation Decisions

- **`LoadoutHeaderProvider`** (`modbench/src/LoadoutHeaderProvider.ts`) lives at the
  composition root and imports from neither bounded context. Every piece of state arrives as
  an injected getter — `activeProfile`, `deployment` — which is both the language-boundary
  constraint (the merged plugins provider carries the same one) and what makes the
  whole surface unit-testable without a VS Code harness. It reads no backend/load order state at
  all (see *mEdit lives on the Plugins view*).
- **It owns no state.** Profile comes from `Mo2ModlistSource`, deployment from the deploy
  manifest. The header re-reads; it never caches.
- **Refresh triggers** are the transitions themselves: a profile switch, a deploy or purge, and
  a change to `modbench.mods.deploymentMode`.
- **The four-row ceiling is a design constraint, not a limit of the widget.** A fifth candidate
  row is a signal that the state belongs in a tree or the status bar. Today there are two.

## Testing

- `src/test/LoadoutHeaderProvider.test.ts` — every row, as a function of injected state; also
  guards that no mEdit row exists.
- `src/test/packageJson.test.ts` — the header is first in the container and ungated; the
  placement rubric (slots, icon ceiling, workspace actions absent from domain trees,
  destructive actions out of navigation) holds across every contributed menu.
- `src/test/integration/extension.test.ts` — `modbench.refresh` and `modbench.launch` register.
