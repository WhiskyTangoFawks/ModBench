---
status: accepted
---

# MO2's Mods/Plugins/Downloads panels map onto native VS Code surfaces, not a custom panel switcher

Modbench's goal is to reconstruct MO2's workflow — a persistent Mods list on the left, a
switchable Plugins/Downloads/Archives tab group on the right — using VS Code's own UI conventions
rather than reinventing MO2's layout widgets. Three placement decisions follow:

- **Mods** and **Plugins** are both native sidebar `TreeView`s, stacked in the `modbench` view
  container (the same pattern as Explorer's OPEN EDITORS/EXPLORER/TIMELINE stack: independently
  collapsible, vertically resizable, simultaneously visible). Both are touched constantly
  mid-workflow, so both get a permanent slot rather than living behind a switcher, and both get
  native checkbox/drag-reorder/keyboard-nav for free (`TreeDragAndDropController`). Plugins is
  **the one Plugins tree** ([ADR-0035](0035-one-plugins-tree-editing-is-a-capability.md)): Mod
  Management owns its rows (`plugins.txt`, no backend required) and a running editing backend adds
  record browsing beneath them.
- **Downloads** is a native `TreeView`, third in the loadout stack below Mods and Plugins (flat
  list, status columns, right-click actions — the same native-context-menu pattern Mods/Plugins
  use), registered `"visibility": "collapsed"` by default. A status-bar item gives the ambient
  "↓ N downloading" glance. Downloads is occasional — fetched-but-unresolved archives aren't
  referenced mid-navigation the way Mods/Plugins are — which is the argument for staying collapsed
  until there's something to act on, not for a different surface.
- **Archives** (MO2's constructed-VFS view) has no equivalent — Modbench never builds a merged
  view ([ADR-0022](0022-extension-owns-backend-lifecycle.md)).

**The auxiliary bar (Secondary Side Bar) is never a default target for any Modbench view.** It's
the conventional home for agentic chat (Copilot Chat, Claude Code) — an assumed-present part of
the UX this product is built around — so defaulting a Modbench view there would put it in
competition with chat for screen space. Views remain user-relocatable there (and everywhere else)
via VS Code's built-in "Move View" — core shell behavior, no extension code — so a user who wants
MO2's literal side-by-side layout can build it by dragging the Plugins view to the auxiliary bar.
Modbench just never assumes that choice on their behalf; nothing reserves or locks the bar.

## Alternatives rejected

- **Two sidebar view containers by default (Mods+Plugins primary, Downloads in the aux bar), for
  literal MO2 parity** — claims the space reserved for chat by default.
- **Custom webview tab-switcher mimicking MO2's three-tab panel** — reinvents a widget VS Code
  already provides native equivalents for; the whole point is leaning on the platform instead of
  rebuilding MO2's chrome.
- **Downloads as an editor-tab webview** (this ADR's original answer, reversed before the surface
  shipped) — justified by the richer per-item meta a tab's width could show; the surface that
  shipped renders four columns behind a native context menu, with nothing a tree can't show, so
  the `downloads` webview bundle was deleted and `modbench.downloads.open` gave way to VS Code's
  auto-generated `modbench.downloads.focus`.
- **Two separate Plugins trees, one per bounded context** (this ADR's original answer, reversed by
  ADR-0035) — kept Mod Management's load order apart from the editing record browser on the
  grounds that a merge would conflate the contexts and tie load-order editing to backend
  lifecycle. Both objections are answered structurally in ADR-0035: the merged tree works with no
  backend, and the composite lives at the composition root with neither context importing the
  other's vocabulary.
