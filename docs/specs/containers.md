# Modbench containers — Surface Specification

**Status: Implemented.** Launch… is a placed affordance whose wiring is deferred — see
*Launch…* under *The Toolbox* below.

A composition-root spec: the two view containers Modbench contributes to VS Code, the views
each holds in default order, and the title-bar placement rules every one of those views
carries. It belongs to neither bounded context
([CONTEXT.md](../../CONTEXT.md)) — a container holds views from both, and the
placement rules are UI mechanics, not domain vocabulary.

Per-view behavior lives in each view's own spec: [Mods](mods.md), [Plugins](plugins.md),
[Downloads](downloads.md), [Referenced By](medit-referenced-by.md). This spec is where a new
view or command's title-bar home is decided; read it before placing one.

## The two containers

### Activity Bar — `modbench`

| Order | View | id | Context |
| --- | --- | --- | --- |
| 1 | Toolbox | `modbench.toolbox` | Composition root — see *The Toolbox* below |
| 2 | Mods | `modbench.modList` | Mod Management |
| 3 | Plugins | `modbench.pluginListTree` | Mod Management, plus Editing's record rows once a load order is running ([ADR-0002](../adr/0002-mod-management-and-editing-are-one-tool.md)) |
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

## The Toolbox — the view of the instance, and the composition root

`modbench.toolbox`, pinned first in the `modbench` container, present unconditionally. Unlike
the other three views it is not a tree: MO2's top bar rendered as a small readout whose rows
double as commands, playing the part a container-level settings/actions panel would if VS Code
exposed one for a multi-view container (it doesn't — see *Rule 1* below). Its title bar is the
home for every workspace-scope action that isn't about any one domain tree.

It renders the **Instance**'s value
([ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md))
and nothing else: the active profile and deployed-ness are fields of that value, so the readout
can never disagree with what the trees below it show. It names *profiles* and a *deployment*,
and never records, FormKeys, mods or files.

It is also the MO2 side's **composition root**. It constructs the Instance, the Mods, Plugins
and Downloads views, every MO2-side gesture and the backend load-order sync; disposing it
disposes all of them. The extension entry point (`modbench/src/extension.ts`) constructs the
Toolbox and the editing side, and nothing else.

It is deliberately *not* a dashboard. It has a hard ceiling of four rows, and a row earns its
place by being state the user needs at a glance while working in the trees below it.

### When there is no instance

With no workspace open, or a workspace that isn't an MO2 instance, the view registers but
renders **no rows**, and Launch…, Deploy and Purge are withheld from its title bar
(`modbench.workspaceIsMo2Instance`). The commands every row activates are registered alongside
the other three views, so on those paths they do not exist — rows would be clicks that throw.
The Mods view's own `viewsWelcome` is what explains the situation to the user; the Toolbox
stays quiet rather than repeating it.

### Rows

| Row | Description | Activates |
| --- | --- | --- |
| Profile | active profile name, or `—` when the Instance has landed no value yet | Switch Profile |
| Deployment | `deployed` / `not deployed` | Deploy, when not deployed |

- The **Profile** row reads `—` rather than erroring while the Instance holds its empty
  pre-first-read value: a readout blip is ADR-0019's background tier, not a toast.
- The **Deployment** row reads deployed-ness from the Instance's `deployed` field — the
  presence of the deploy manifest (`mods/.medit-manifest.json`), the same question purge
  already asks, so the readout cannot disagree with what purge would do. A corrupt manifest
  reads as deployed: there is state out there needing a purge, which is what the row should
  say. When deployed, the row is an inert readout — Purge is destructive and stays in overflow
  behind a modal. Deploying into a directory whose manifest is absent — the first deploy —
  raises a modal confirmation first (see [mods.md](mods.md)); the row itself carries no trace
  of that, since it is asked only once the row's own Deploy command runs.

### mEdit has no lifecycle affordance

The backend launches with the extension (the DB-file-backed session makes startup cheap enough
that lifecycle is not a user decision); the [Plugins view](plugins.md) carries no Launch mEdit /
Close mEdit toggle. The Toolbox carries no mEdit row of any kind, running or not, and reads no
backend/load order state — `ToolboxProvider` only ever reads the Instance's value. (The earlier
ruling that placed the pair — "launch mEdit should be an option on the plugins view" — is
superseded by there being no pair to place.)

### Toolbox title bar

| Slot | Action | Gate |
| --- | --- | --- |
| `navigation@1` | Refresh | always |
| `navigation@2` | Launch… | MO2 instance open |
| overflow | Deploy, Purge | MO2 instance open |

**Refresh** is one command id (`modbench.refresh`) that refreshes the whole of Modbench, not only
Mod Management. It re-reads mods, plugins and downloads from disk as it always did, and it also
drops the Index and rebuilds it from scratch: every plugin re-indexed from its bytes, every
tracked mod re-ingested from its source, through the same path the first load takes (ADR-0014).
A partial refresh is the state where the user believes they have resynced and one tree still
quietly disagrees. Refresh remains a safety net for flaky watch events, never the primary path:
every one of those sources is otherwise watcher-driven.

The rebuild is one backend call that drops the index file and reopens it empty, refusing (423)
exactly as a load-order send does when another window holds it; the extension then resends the
load order exactly as it does at startup, so the rebuild is the ordinary cold load and needs no
code of its own. The Plugins view shows the same reconcile progress it shows for a cold load. A
failed rebuild (423, or the backend down) stops Refresh there — no load order is sent and no tree
is re-read — and is reported the way any other failed gesture is.

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

### Deltas the Toolbox absorbed

Historical record from before the merge of Mod Management's "Plugins (load order)" and
Editing's "mEdit Plugins tree" into the one shared Plugins tree that exists today — the two
"Plugins" rows below describe the two pre-merge views, not two views that exist now.

| View | Lost | Result |
| --- | --- | --- |
| Mods | Switch Profile, Launch mEdit (since removed entirely), Refresh, Deploy, Purge, Launch Game | Filter, sort-direction toggle, Collapse All — **nine icons to three** |
| Plugins (load order) | Refresh | Filter only |
| Downloads | — | Filter gained at slot 1, show-hidden toggle moved to slot 2, Sort by… stays in overflow |
| Plugins (Editing) | Refresh, Close mEdit (since removed entirely) | Name filter, record filter, New Plugin, **Collapse All gained** |

### Implementation Decisions

- **`ToolboxProvider`** (`modbench/src/ToolboxProvider.ts`) renders its rows from one injected
  getter over the Instance's value — `{ activeProfile, deployed }`. That is both what keeps the
  readout from drifting from the trees and what makes the whole surface unit-testable without a
  VS Code harness. It reads no backend/load order state at all (see *mEdit has no lifecycle
  affordance* above).
- **It owns no state.** Both fields belong to the Instance; the Toolbox re-renders, it never
  caches.
- **`createToolbox`** (`modbench/src/toolbox.ts`) is the composition root: the Instance, the
  four views, every MO2-side gesture and the load-order sync are built there. Everything it
  constructs is registered through one `own()` and disposed with it.
- **Re-render triggers** are a landed Instance recompute — a profile switch, a deploy and a
  purge all reach it as a watched file changing.
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
   it goes on the Toolbox, the status bar, or the palette.
   *Rejected alternative*: a container-level `…` shared by every view in the `modbench`
   container. It doesn't exist — VS Code's menu contribution points are enumerated and there is
   no `viewsContainer/title`; what renders at the top of a multi-view container is VS Code's own
   auto-generated **Views** menu (show/hide each view, Reset View Locations, Move View), which
   exists because the container holds several views and cannot be injected into. So a shared
   home has to be a real view — the Toolbox.

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
   they sit in the Toolbox's overflow, behind a modal confirm, never in the navigation group.
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
   Downloads, the Toolbox — no. On a flat list the icon is one that does nothing.
   *Rejected alternative*: not recorded.
   **This is the one rule with no test seam.** `showCollapseAll` is a `createTreeView` option
   with no declarative contribution and no readable property on the returned `TreeView`, so it
   is checked by reading the `createTreeView` call sites (`toolbox.ts` for Plugins,
   `modmanager/modManagementCommands.ts` for Mods) rather than by a test.

## Testing

- `src/test/ToolboxProvider.test.ts` — every Toolbox row, as a function of the Instance value it
  is handed; also guards that no mEdit row exists.
- `src/test/toolboxScan.test.ts` — the retired names (`Loadout`, "modlist source") appear in no
  source file or `package.json` entry, and every disposable `toolbox.ts` constructs is
  registered for the Toolbox's own teardown.
- `src/test/packageJson.test.ts` — the Toolbox is first in the container and ungated; the
  placement rubric (slots, icon ceiling, workspace actions absent from domain trees, destructive
  actions out of navigation, icon vocabulary) holds across every contributed menu. Each `it`
  carries a pointer comment to the rule number here, not the rule's own text.
- `src/test/integration/extension.test.ts` — `modbench.refresh` and `modbench.launch` register.
