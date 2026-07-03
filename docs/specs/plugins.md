# Plugins (Load Order) — Surface Specification

**Status: Planned — not implemented.** This skeleton anchors the surface's placement and scope ahead of implementation, tracked as issue [#7](https://github.com/WhiskyTangoFawks/mEdit/issues/7) (Modbench-9).

Mod Management context — operates on physical plugin files (`.esm`/`.esp`/`.esl`) and `plugins.txt`; never on records or FormKeys. Distinct from the Editing-context Plugins tree ([medit.md](medit.md) §2), which lists plugins as the entry point into per-record browsing and requires a spawned backend — this surface manages **load order**, not record content, and works without the editing backend running.

## Purpose

Reconstruct MO2's Plugins tab: view and manage `plugins.txt` load order — enable/disable, drag-and-drop reorder, dependency-aware auto-sort, missing-master detection — as a first-class, always-available part of the Loadout workflow.

## Placement ([ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md))

A sidebar `TreeView`, stacked below the Mods tree in the `modbench` view container, visible in Loadout mode alongside it (not a switchable tab, not folded into the mEdit Plugins tree). Reuses the `TreeDragAndDropController` pattern already built for the Mods tree ([mods.md](mods.md) §UI — Mods tree) for reorder.

Freely relocatable by the user (e.g. to the auxiliary bar, to reconstruct MO2's literal side-by-side layout) via VS Code's native "Move View" — but never defaults there. The auxiliary bar is reserved by convention for agentic chat surfaces (Copilot Chat, Claude Code); Modbench's default layout never claims it.

## Intended shape (to be confirmed when #7 is implemented)

- One row per plugin, in `plugins.txt` order; checkbox enable/disable.
- Drag-and-drop reorder writes `plugins.txt` immediately (same immediate-write convention as the Mods tree — no save/discard flow).
- Missing-master badge (✗) via `MasterReader` (tiny TES4-header read, no Mutagen).
- Auto-sort: dependency-only topological sort by declared masters (simplified LOOT — no rule database, no masterlist).
- Vanilla/DLC/Creation Club content is currently unmanaged and unsurfaced anywhere (see issue [#12](https://github.com/WhiskyTangoFawks/mEdit/issues/12)) — this view is a natural place to make it visible, since MO2 itself surfaces it in the equivalent Plugins tab.

## Open questions

- Exact row anatomy beyond the missing-master badge (provided-by-mod annotation? conflict indicator, distinct from the Mods tree's file-conflict badges?).
- Whether auto-sort previews changes before applying, or applies immediately like every other mutation in this view.
- How this view's missing-master detection relates to the Mods tree's own missing-master badge ([mods.md](mods.md) §Conflict index & status badges) — likely the same underlying check, surfaced in two places.
