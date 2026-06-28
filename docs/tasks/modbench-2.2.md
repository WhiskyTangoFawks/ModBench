# Modbench-2.2 — Tree UI & core interactions

**Status: Not Started** · Parent: [modbench-2](modbench-2.md) · Depends on: 2.1 · **Model: Opus 4.8**

*Goal: A working Mod List tree in the VS Code sidebar — collapsible separators, ungrouped mods, enable/disable via checkbox, profile selector, and header buttons. No drag-and-drop, no filter, no context menus yet (those are 2.3).*

The heterogeneous root (separator nodes + ungrouped mods as direct root children) is the structural nuance to get right here. Everything in 2.3 builds on this tree being stable.

See [UI_SPEC §1–§5](../../medit-vscode/src/modmanager/docs/UI_SPEC.md).

---

## Extension

- [ ] `ModListProvider` (`TreeDataProvider<ModlistNode>`) — sidebar Mod List tree:
  - **Ungrouped mods** (before the first separator in `modlist.txt`, or between no separators): direct root-level items above all separator nodes. Not wrapped in a synthetic container.
  - **Separator nodes**: collapsible (`TreeItemCollapsibleState.Collapsed`); children are the mods between this separator and the next in `modlist.txt`.
  - **Mod row**: VS Code native checkbox (`checkboxState`); label = mod name; description = version from `meta.ini` (blank if absent); generic mod icon; tooltip = full name · version · Nexus ID · archive filename.
  - **Separator row**: non-checkbox tree item; label = separator name; collapsible.
- [ ] **Enable/disable** — `onDidChangeCheckboxState` → immediate write of `+`/`-` prefix via the active `IModlistSource`; refresh affected nodes.
- [ ] **Profile selector** — "Switch Profile" icon button in tree header → VS Code quick-pick listing `profiles/` subdirectories. Selecting one persists `selected_profile` and calls `ModListProvider.refresh()`. Current profile name shown as tree view `description` subtitle.
- [ ] **Header buttons**: Filter (magnifier — stub, reveals nothing yet; wired in 2.3), Switch Profile, Launch mEdit (stub — wired in Modbench-5), Collapse All (VS Code built-in), Refresh (calls `refresh()`).
- [ ] **Count root node** — non-interactive first item: "247 active / 312 installed" (counts from the in-memory modlist).
- [ ] Register the Mod List view in `package.json` under the `medit` view container, with `when` clause so it shows by default (mEdit view hidden until Modbench-5 wires the toggle).

---

## Tests

- [ ] Unit: `ModListProvider` builds the correct node tree from a fixture modlist (ungrouped mods at root, separators with correct children, count node).
- [ ] Unit: toggling a mod checkbox calls `IModlistSource.setEnabled` and refreshes the node.
- [ ] Unit: selecting a profile via quick-pick persists `selected_profile` and triggers a tree refresh.
- [ ] Integration: Mod List tree renders for a fixture instance; Switch Profile, Launch mEdit, Refresh commands registered.

---

## Proof

*To be filled in on completion. Paste `npm run test:unit` / `test:integration` output and commit hash here.*
