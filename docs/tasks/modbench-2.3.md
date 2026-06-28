# Modbench-2.3 — Drag-and-drop, filter & context menus

**Status: Not Started** · Parent: [modbench-2](modbench-2.md) · Depends on: 2.2 · **Model: Sonnet 4.6**

*Goal: Complete the Mod List interactions — drag-to-reorder (mod + separator block move), live filter with separator-grouping toggle, and all mod/separator context menu actions. All spec'd; mechanical to implement on the stable tree from 2.2.*

See [UI_SPEC §4, §6](../../medit-vscode/src/modmanager/docs/UI_SPEC.md).

---

## Extension

### Drag-and-drop

- [ ] `TreeDragAndDropController` on `ModListProvider`:
  - **Mod drag**: reorders the mod's line in `modlist.txt`; writes immediately via the active source.
  - **Separator drag**: moves the separator line and all its children as a block to the drop position. The flat `modlist.txt` order after the drop must equal: prefix entries → separator line → children in their original relative order → rest.
  - Drop onto a separator header = add to that separator's section (append after last child).
  - Drop between separators or at root level = ungrouped at that position (no separator attribution).

### Filter

- [ ] Magnifier button wires up to reveal a filter input (use VS Code `TreeView` `filterOnType` or an inline quick-input — pick whichever avoids a custom webview).
- [ ] Filter matches mod name and separator name (case-insensitive substring).
- [ ] Toggle button beside filter input:
  - **On** (default): auto-expand separators with matches; hide separators with no matches. Mods shown under their separator for context.
  - **Off**: flat list of matching mods; separators hidden entirely.
- [ ] Toggle resets to **on** when the filter is cleared. Not persisted between sessions.

### Context menus

**Mod** (`contextValue: "mod"`):

- [ ] **Open in Explorer** — `vscode.commands.executeCommand('revealInExplorer', modFolderUri)`.
- [ ] **Add Separator Below** — quick-input for separator name; inserts a new separator line immediately below this mod in `modlist.txt`; writes immediately.
- [ ] **Move to Separator** — quick-pick listing all separator names + "Ungrouped" at top; moves mod to end of selected separator's section (or to ungrouped position if "Ungrouped" chosen); writes immediately.
- [ ] **Uninstall** — confirmation prompt naming the mod; removes `mods/<name>/` from disk and removes the entry from `modlist.txt` via the active source.
- [ ] **View on Nexus** — opens `https://www.nexusmods.com/fallout4/mods/<nexusId>` in browser; only shown when `meta.ini` has a Nexus ID. (Game slug is configurable for multi-game support; use `GameDirectory` to resolve it.)

**Separator** (`contextValue: "separator"`):

- [ ] **Rename** — quick-input prompt pre-filled with current name; writes updated separator line to `modlist.txt` immediately.
- [ ] **Add Separator Below** — same as on mods: quick-input for name, inserts after this separator's last child.
- [ ] **Delete Separator** — removes only the separator line; its mods are promoted to the nearest preceding separator (or ungrouped if none). No confirmation prompt (non-destructive — mods are never deleted).

---

## Tests

- [ ] Unit: mod drag reorders entries in `modlist.txt` correctly.
- [ ] Unit: separator drag moves the separator + all children as a block; entries before and after are unaffected.
- [ ] Unit: dropping a mod onto a separator header appends it to that separator's section.
- [ ] Unit: dropping a mod at root level between two separators makes it ungrouped at that position.
- [ ] Unit: filter with toggle **on** — separator with no matches hidden; separator with matches includes only matching children.
- [ ] Unit: filter with toggle **off** — flat list of matching mods, no separators.
- [ ] Unit: filter matches separator name — all children of a matching separator shown.
- [ ] Unit: "Move to Separator" moves mod to end of target separator's section.
- [ ] Unit: "Delete Separator" removes separator line; mods promoted to ungrouped.
- [ ] Integration: drag, filter, and context menu commands all registered.

---

## Proof

*To be filled in on completion. Paste `npm run test:unit` / `test:integration` output and commit hash here.*
