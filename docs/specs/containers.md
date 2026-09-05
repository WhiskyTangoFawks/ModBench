# Modbench containers — Surface Specification

**Status: Implemented.** Launch… is a placed affordance whose wiring is deferred — see
*Launch…* under *The Loadout view* below.

A composition-root spec: the two view containers Modbench contributes to VS Code, the views
each holds in default order, and the title-bar placement rules every one of those views
carries. It belongs to neither bounded context
([CONTEXT-MAP.md](../../CONTEXT-MAP.md)) — a container holds views from both, and the
placement rules are UI mechanics, not domain vocabulary.

Per-view behavior lives in each view's own spec: [Mods](mods.md), [Plugins](plugins.md),
[Downloads](downloads.md), [Referenced By](medit-referenced-by.md). This spec is where a new
view or command's title-bar home is decided; read it before placing one.

## The two containers

### Activity Bar — `modbench`

| Order | View | id | Context |
| --- | --- | --- | --- |
| 1 | Loadout | `modbench.loadoutHeader` | Composition root — see *The Loadout view* below |
| 2 | Mods | `modbench.modList` | Mod Management |
| 3 | Plugins | `modbench.pluginListTree` | Mod Management, plus Editing's record rows once a load order is running ([ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md)) |
| 4 | Downloads | `modbench.downloads` | Mod Management; registered collapsed by default |

Every view here is contributed unconditionally — there is no `modbench.viewMode` context key
and no view that hides itself as a group. A view with nothing to show (no workspace, or a
workspace that isn't an MO2 instance) renders its own empty/welcome state instead.

### Panel — `modbenchReferencedBy`

| Order | View | id | Context |
| --- | --- | --- | --- |
| 1 | Plugins - Referenced By | `modbench.referencedByTree` | Editing |

Referenced By is a Panel-location container, not a view stacked under `modbench` in the
Activity Bar — it follows the active record editor the way Problems/Output/Terminal follow the
active editor, and the *why* (a sidebar view cannot sit beside the record editor tab the way a
panel view can) is specced in full in [medit-referenced-by.md](medit-referenced-by.md); it is
not repeated here.

## The Loadout view — the container's settings view

`modbench.loadoutHeader`, pinned first in the `modbench` container, present unconditionally.
Unlike the other three views it is not a tree: a small readout whose rows double as commands,
playing the part a container-level settings/actions panel would if VS Code exposed one for a
multi-view container (it doesn't — see *Rule 1* below). Its title bar is the home for every
workspace-scope action that isn't about any one domain tree.

It reads Mod-Management state (profile, deployment), so it carries no domain vocabulary of its
own: it names *profiles* and a *deployment*, and never records, FormKeys, mods or files.

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

The backend launches with the extension (the DB-file-backed session makes startup cheap enough
that lifecycle is not a user decision); the [Plugins view](plugins.md) carries no Launch mEdit /
Close mEdit toggle. This header
carries no mEdit row of any kind, running or not, and reads no backend/load order state —
`LoadoutHeaderProvider` only ever reads Mod-Management state. (The earlier ruling that placed
the pair — "launch mEdit should be an option on the plugins view" — is superseded by there
being no pair to place.)

### Header title bar

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

### Deltas this view absorbed

Historical record from before ADR-0035 merged Mod Management's "Plugins (load order)" and
Editing's "mEdit Plugins tree" into the one shared Plugins tree that exists today — the two
"Plugins" rows below describe the two pre-merge views, not two views that exist now.

| View | Lost | Result |
| --- | --- | --- |
| Mods | Switch Profile, Launch mEdit (since removed entirely), Refresh, Deploy, Purge, Launch Game | Filter, sort-direction toggle, Collapse All — **nine icons to three** |
| Plugins (load order) | Refresh | Filter only |
| Downloads | — | Filter gained at slot 1, show-hidden toggle moved to slot 2, Sort by… stays in overflow |
| Plugins (Editing) | Refresh, Close mEdit (since removed entirely) | Name filter, record filter, New Plugin, **Collapse All gained** |

### Implementation Decisions

- **`LoadoutHeaderProvider`** (`modbench/src/LoadoutHeaderProvider.ts`) lives at the
  composition root and imports from neither bounded context. Every piece of state arrives as
  an injected getter — `activeProfile`, `deployment` — which is both the language-boundary
  constraint (the merged plugins provider carries the same one) and what makes the
  whole surface unit-testable without a VS Code harness. It reads no backend/load order state at
  all (see *mEdit has no lifecycle affordance* above).
- **It owns no state.** Profile comes from `Mo2ModlistSource`, deployment from the deploy
  manifest. The header re-reads; it never caches.
- **Refresh triggers** are the transitions themselves: a profile switch, a deploy or purge, and
  a change to `modbench.mods.deploymentMode`.
- **The four-row ceiling is a design constraint, not a limit of the widget.** A fifth candidate
  row is a signal that the state belongs in a tree or the status bar. Today there are two.

## Title bar

Every view above carries the same title bar, filled from the same fixed slot vocabulary
(*Rule 5* below): `navigation@1`, `navigation@2`, … for icons, then an overflow `…` menu, then
VS Code's own **Collapse All** on a hierarchical tree.

### The seven placement rules

Five view title bars each grew independently as their own features shipped, and roughly half
the icons they accumulated were not about those trees at all. Switch Profile swapped the
modlist *and* `plugins.txt` *and* invalidated any running load order, but sat on the Mods tree
because Mods existed first. Launch mEdit and Close mEdit sat on whichever view happened to be
visible at the time. Refresh was re-invented three times under three command ids for one need.
Deploy, Purge and Launch Game sat on Mods because Mods was the only host. The Mods tree
reached nine navigation icons with nothing in overflow, which VS Code silently collapses into
`…` anyway once the sidebar is narrow. These seven rules are the answer, enforced in
`modbench/src/test/packageJson.test.ts` except where noted.

1. **Scope first.** An action that isn't about a tree's own domain doesn't go on that tree —
   it goes on the Loadout view, the status bar, or the palette.
   *Rejected alternative*: a container-level `…` shared by every view in the `modbench`
   container. It doesn't exist — VS Code's menu contribution points are enumerated and there is
   no `viewsContainer/title`; what renders at the top of a multi-view container is VS Code's own
   auto-generated **Views** menu (show/hide each view, Reset View Locations, Move View), which
   exists because the container holds several views and cannot be injected into. So a shared
   home has to be a real view — the Loadout view.

2. **Four navigation icons maximum, in any state.** VS Code collapses navigation icons into
   `…` when a view is narrow, so a fifth is unreliable — not a matter of taste. A two-command
   context-key toggle (e.g. a filter's open/clear pair) counts as one, since only one of the
   pair is ever visible.
   *Rejected alternative*: not recorded — no wider ceiling or per-view exception is on record
   as having been considered.

3. **An icon is earned**, or it goes to overflow. Downloads' **Show hidden** is a state
   readout (the glyph names whether hidden rows are showing) and keeps its icon; Downloads'
   **Sort by…** is configure-once and sits in the `…` overflow menu, unadorned, "so it doesn't
   compete for title-bar space" ([downloads.md](downloads.md)).
   *Rejected alternative*: not recorded.

4. **Destructive actions never get an icon.** Deploy and Purge rewrite the game directory;
   they sit in the header's overflow, behind a modal confirm, never in the navigation group.
   *Rejected alternative*: not recorded.

5. **Fixed slot order**, so an icon means the same thing in every view: name filter, then the
   view's own state affordance (a presentation toggle, or a second narrowing axis like the
   Plugins tree's record filter), then domain actions, then overflow, then native
   **Collapse All** last ([plugins.md](plugins.md)). Slots are assigned in that order, skipping
   whatever a view doesn't have.
   *Rejected alternative*: not recorded.

6. **Icon vocabulary is fixed and never doubles up.** `$(search)` narrows by name;
   `$(filter)` narrows by condition — the Plugins tree keeps both, distinct, on the same title
   bar precisely so the two axes never read as the same action. A durable filter's clear
   variant is `$(clear-all)`, the icon VS Code's own Extensions view uses for the same job;
   `$(search-stop)` was rejected because it means halting a search in progress, implying
   results stay. `$(refresh)` is **one** command id (`modbench.refresh`) covering every
   Mod-Management source at once — a per-view refresh was rejected because a partial refresh
   is the state where the user believes they've resynced and one tree still quietly disagrees.
   *Rejected alternative*: per-icon, above — `$(search-stop)` for clear, and a per-view
   refresh command, both rejected on the grounds stated.

7. **`showCollapseAll` on every hierarchical tree, never on a flat list.** Currently: Mods and
   the merged Plugins tree (plugin → record type → record) — yes; Plugin List (removed),
   Downloads, the Loadout view — no. On a flat list the icon is one that does nothing.
   *Rejected alternative*: not recorded.
   **This is the one rule with no test seam.** `showCollapseAll` is a `createTreeView` option
   with no declarative contribution and no readable property on the returned `TreeView`, so it
   is checked by reading the `createTreeView` call sites (`extension.ts` for Plugins,
   `modmanager/modManagementCommands.ts` for Mods) rather than by a test.

## Testing

- `src/test/LoadoutHeaderProvider.test.ts` — every Loadout-view row, as a function of injected
  state; also guards that no mEdit row exists.
- `src/test/packageJson.test.ts` — the Loadout view is first in the container and ungated; the
  placement rubric (slots, icon ceiling, workspace actions absent from domain trees, destructive
  actions out of navigation, icon vocabulary) holds across every contributed menu. Each `it`
  carries a pointer comment to the rule number here, not the rule's own text.
- `src/test/integration/extension.test.ts` — `modbench.refresh` and `modbench.launch` register.
