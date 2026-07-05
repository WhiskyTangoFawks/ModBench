---
status: accepted
---

# MO2's Mods/Plugins/Downloads panels map onto native VS Code surfaces, not a custom panel switcher

Modbench's goal is to reconstruct MO2's workflow — a persistent Mods list on the left, a switchable Plugins/Downloads/Archives tab group on the right — using VS Code's own UI conventions rather than reinventing MO2's layout widgets. Three placement decisions follow:

- **Mods** and **Plugins (load order)** are both native sidebar `TreeView`s, stacked in the `modbench` view container (the same pattern as Explorer's OPEN EDITORS/EXPLORER/TIMELINE stack: independently collapsible, vertically resizable, simultaneously visible). Both are touched constantly mid-workflow, so both get a permanent slot rather than living behind a switcher. Stacking Plugins as a second tree also gets native checkbox/drag-reorder/keyboard-nav for free, reusing the `TreeDragAndDropController` pattern already built for the Mods tree (feeds into #7 / Modbench-9). Plugins (load order) is a Mod Management concern — physical plugin files, `plugins.txt`, no backend required — deliberately kept separate from the Editing-context `modbench.pluginTree` (`medit.md` §2) it superficially resembles: that tree is per-record browsing and requires a spawned backend.
- **Downloads** is a webview opened as an editor tab — the same mechanism the Record Editor panel already uses via `modbench.openEditor` — plus a status-bar item for the ambient "↓ N downloading" glance (already sketched in `downloads.md`). Downloads is occasional and rich (meta-info columns, batch context-menu actions: install/reinstall/delete/hide, hash-based Nexus lookup) rather than something referenced mid-navigation the way Mods/Plugins are, so an editor tab's free arrangement (split, pin, close) outweighs losing a native tree widget for it.
- **Archives** (MO2's constructed-VFS view) has no equivalent — Modbench never builds a merged view ([ADR-0022](0022-extension-owns-backend-lifecycle.md)).

**The auxiliary bar (Secondary Side Bar) is never a default target for any Modbench view.** It's the conventional home for agentic chat (Copilot Chat, Claude Code) — an assumed-present part of the UX this product is built around — so defaulting a Modbench view there would put it in competition with chat for screen space. Views remain user-relocatable there (and everywhere else) via VS Code's built-in drag-to-move / "Move View" command — core shell behavior, no extension code required — so a user who wants MO2's literal side-by-side layout can build it themselves by dragging the Plugins view to the auxiliary bar. Modbench just never assumes that choice on their behalf.

## Considered options

**Two sidebar view containers by default (Mods+Plugins primary, Downloads secondary/aux bar), for literal MO2 parity** — rejected: claims the space reserved for chat by default.

**Custom webview tab-switcher mimicking MO2's exact three-tab panel** — rejected: reinvents a widget (tab-switching, panel docking) VS Code already provides native equivalents for; the whole point is leaning on the platform instead of rebuilding MO2's chrome.

**Plugins (load order) folded into the existing Editing `pluginTree`** — rejected: conflates two bounded contexts (Mod Management vs Editing) that `CONTEXT-MAP.md` deliberately separates, and would tie load-order editing to backend/session lifecycle when it should work without a spawned backend.

**Downloads as a bottom-panel tree (Ports-panel style: flat list, status column, right-click actions)** — a real, viable alternative; not chosen because Downloads' richer per-item meta info benefits from an editor tab's width, but noted here as the fallback if the tab approach doesn't scale.

## Consequences

- `docs/specs/mods.md` — Plugin load order section updated to point at the new `docs/specs/plugins.md`; "Plugins surface" open question resolved.
- `docs/specs/plugins.md` — new surface spec (skeleton; Planned) for the Plugins (load order) sidebar view.
- `docs/specs/downloads.md` — Queue UI open question resolved: editor-tab webview + status-bar item, not a dedicated tree or quickpick-only.
- Plugins / load-order surface decision resolved; implementation tracked as issue #7 (milestone 1 — Mod-management maturity).
- No extension code reserves or locks the auxiliary bar — it is an unenforced default, not a technical constraint.
