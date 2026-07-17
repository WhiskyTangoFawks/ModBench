# mEdit — Context Overview

**Status: Implemented.**

This is the **overview** for the mEdit view, not a surface spec. It covers what is shared
across mEdit's surfaces — the session lifecycle, the status bar, the command palette, and the
architecture seams — and points at the spec for each surface. Anything specific to one surface
lives in that surface's spec.

Editing context — operates on **records**, **FormKeys**, and **plugins** (physical
`.esp`/`.esm`/`.esl` files loaded by the backend); the Mod-Management vocabulary ("mod",
"loadout", "deploy") belongs to the sibling surfaces, not here
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

Placement: [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md) — native VS Code
views (sidebar trees + editor-tab webviews), not a custom panel switcher. The Loadout surface
that launches this one is specified in [mods.md](mods.md); the planned Mod-Management Plugins
load-order tree — a *different* "Plugins" surface — in [plugins.md](plugins.md).

**Vocabulary note:** the mEdit "Plugins tree" is the entry point into per-record browsing and
requires a spawned backend; it is distinct from the Mod-Management **Plugin List**
([plugins.md](plugins.md)), which manages `plugins.txt` load order and runs without the
backend. Both display as "Plugins" but are visible in mutually exclusive view modes and stay
fully distinct in code.

## Problem Statement

A mod author building a loadout needs to see what each plugin actually declares, understand how
overrides across plugins interact, and edit records — but the established tool for this (xEdit)
is a standalone Windows application, disconnected from where the loadout is managed. Conflicts
between plugins are the crux of patching: a modder needs to know, for a given record and field,
which plugin wins, which lost an override, and whether an apparent conflict is a real
disagreement or an identical duplicate — and then make a targeted edit that stages cleanly and
writes back to the right physical file. Without an integrated editor, they leave their loadout
tool, load a separate program, hand-correlate what it shows against their mod list, and edit
blind to the loadout context.

## Solution

The **mEdit view** — a set of native VS Code surfaces driven by a lazily-spawned C# backend
session over the active loadout:

| Surface | What it is | Spec |
| --- | --- | --- |
| **Plugins tree** | Sidebar tree; the entry point for all navigation — records by type, a spatial worldspace/cell tree, a Conflicts node, and the SQL record filter | [medit-plugins-tree.md](medit-plugins-tree.md) |
| **Pending Changes tree** | Sidebar tree below it; staged work grouped into the units that must be saved or reverted together | [medit-pending-changes-tree.md](medit-pending-changes-tree.md) |
| **Record editor panel** | Editor-tab webview; the per-field, per-plugin compare grid with conflict color coding and in-place editing that stages pending changes | [medit-record-editor.md](medit-record-editor.md) |
| **Referenced By panel** | Editor-tab webview opened beside it; what points at this record | [medit-referenced-by.md](medit-referenced-by.md) |
| **Status bar item** | Backend/session state | This document |

**Launch mEdit** (from the Loadout header) switches into editing mode, spawns the backend, and
builds the session from the active modlist's enabled plugins plus vanilla masters
(`load-explicit`); **Close mEdit** switches back and tears the session down. Editing writes
records straight to their physical plugin files and never requires a deploy.

## User Stories

Surface-specific stories live in the surface specs above. These are the cross-cutting ones:

1. As a mod author, I want to enter editing mode from my loadout with a single action, so that
   the editor opens against exactly the plugins my active profile loads, with no separate
   session-setup step.
2. As a user, I want a status bar item that tells me whether the backend is running,
   connecting, attached, or has a session loaded (and for which game, with a plugin count), so
   that I always know the editor's state.
3. As a user, I want clicking the status bar item when the backend isn't running to tell me how
   to start it, so that I'm not stuck guessing.
4. As a user, I want leaving editing mode to tear the session down, so that a backend I'm not
   using isn't left running against my loadout.
5. As a user, I want to run a script against the whole session or a specific record/plugin
   (planned), so that I can automate repetitive edits.
6. As a user, I want all of these actions reachable from the command palette as well as the
   tree, so that I can drive the editor by keyboard.

## Implementation Decisions

### Scope & overall layout

- This document and the surface specs cover the **mEdit view's frontend surfaces** and the
  behavior they present. The backend endpoint contract that drives them is governed by
  `MEditService/CLAUDE.md` and the generated API client, not restated here.
- Modbench is a single activity-bar container (`modbench`). A `modbench.viewMode` context key
  toggles the sidebar between the Loadout surface and the mEdit surfaces. **Launch mEdit** (in
  the Loadout header) switches to editing mode, lazily spawning the backend and loading the
  active modlist as the session; **Close mEdit** switches back and tears the session down.
- The mEdit view is composed of the five surfaces listed above. There is no toolbar or
  top-level menu bar — every action is reachable from a tree context menu, the command palette,
  or the record editor panel itself.
- **One spec per surface** (see [README.md](README.md)). A surface is a top-level UI unit the
  user experiences as a tab/view; the status bar item is not one, so it is specified here.

### Status bar

- A bottom-right item reflects backend/session state: **not running** ("backend not running",
  warning color), **connecting**, **attached with no session**, and **attached with a session**
  ("{GameRelease} — {N} plugins", success color).
- Clicking it while the backend is not running shows start-up instructions. Sessions are
  created via **Launch mEdit** from the Loadout surface, never from the status bar.

### Command palette

- All `modbench.*` commands are available in the palette; `package.json`'s
  `contributes.commands` is the canonical registry. Navigation/workflow commands include Launch
  mEdit (enter editing; spawn backend; load the session), Close mEdit (return to Loadout; tear
  down), Reload Session (refresh the tree), Open Editor (internal; also bound to tree click),
  New Plugin…, Copy as Override Into…, and Run Script… (planned; context = the active record if
  a panel is open, else global).
- A new end-to-end command is four touch points, or it is half-wired: backend endpoint →
  `/regenerate-api` → frontend (`PluginRepository`/`SessionController`) → `package.json`
  commands/menus + `extension.ts` registration → `EXPECTED_COMMANDS` in the integration test.

### Architecture / seams

- **The backend is the seam for record data and mutations**: the frontend talks to it only
  through the generated API client; the compare grid, conflict states, references, grouping,
  and all mutations are behaviors of endpoints owned by `MEditService/`. The frontend holds
  rendering and staging logic, not record semantics.
- **Conflict classification** (the two-axis ConflictAll/ConflictThis model,
  [ADR-0016](../adr/0016-two-axis-conflict-model.md)) is computed backend-side and consumed by
  the grid as `cellStates` — the frontend maps states to color, it does not derive them. Its
  visual encoding is specified in [medit-record-editor.md](medit-record-editor.md).
- **ChangeGroups** are derived backend-side as connected components of the pending-change
  dependency graph ([ADR-0028](../adr/0028-change-groups-are-derived-dependency-closures.md));
  the frontend renders grouping and never computes it.
- All backend HTTP calls go through the generated `openapi-fetch` client (`ApiClient`) — never
  raw `fetch()` (`modbench/CLAUDE.md`).
- Errors surface on [ADR-0026](../adr/0026-error-surfacing-policy.md)'s severity tiers via an
  injected reporter, never raw `vscode.window.*` in controllers or repositories.

## Testing Decisions

Per-surface testing decisions live in the surface specs. Shared:

- **Good tests assert external behavior, not implementation details.** Observe a tree through
  `getChildren`/`getTreeItem` and a webview through its props; never assert private internals.
- **Record semantics, conflict classification, and grouping are the backend's responsibility**
  and are tested there (`MEditService/CLAUDE.md`), never re-asserted from the frontend. Frontend
  tests consume representative responses as fixtures.
- **Integration seam** (`npm run test:integration`, real VS Code process): the Plugins tree
  builds from a session, navigation opens a record panel, the record filter prunes the tree, the
  Pending Changes tree reflects staged work, and command registration holds — add any new
  command id(s) to `EXPECTED_COMMANDS` (per `modbench/CLAUDE.md`).

## Out of Scope

- **Run Script…** across session/record/plugin — planned, not yet shipped.
- **Delta / overlay editing** — loading an arbitrary overriding-plugin set side-by-side is a
  Loadout-adjacent concern (see [mods.md](mods.md) Out of Scope); deferred.
- **Load-order editing** — the Mod-Management Plugin List ([plugins.md](plugins.md)), a
  different surface in a different bounded context.
- Anything surface-specific — see the surface specs.

## Further Notes

- mEdit is the **only** view that requires the C# backend; the Mod-Management surfaces
  ([mods.md](mods.md), [downloads.md](downloads.md), [plugins.md](plugins.md)) all run without
  it. The backend lifecycle (spawn on Launch mEdit, teardown on Close mEdit / profile switch /
  workspace close, restart on crash) is owned by the extension per
  [ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md) and specified from the Loadout
  side in [mods.md](mods.md).
- The Editing "Plugins tree" and the Mod-Management "Plugin List" ([plugins.md](plugins.md))
  both display as "Plugins" but are distinct views (`modbench.pluginTree` vs
  `modbench.pluginListTree`), visible in mutually exclusive view modes — see the Vocabulary
  note at the top and [CONTEXT-MAP.md](../../CONTEXT-MAP.md).
