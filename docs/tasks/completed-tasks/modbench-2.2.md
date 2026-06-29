# Modbench-2.2 — Tree UI & core interactions

**Status: Complete** · Parent: [modbench-2](modbench-2.md) · Depends on: 2.1 · **Model: Opus 4.8**

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

Commit: `dc73aef` (branch `modbench-2.2-mod-list-tree`, merged to `main`).

New code: `modlistTree.ts` (pure `groupModlist`), `ModListProvider.ts`
(Count/Separator/Mod nodes, cached tree, `setModEnabled`/`switchProfile`),
wired in `extension.ts` behind the `medit.viewMode` context key (default
`loadout`; gates Plugins/Change Groups behind `editing` until the Modbench-5
toggle). Checkbox write failures surfaced per ADR-0026. 10 new unit tests
(`modlistTree.test.ts`, `ModListProvider.test.ts`); 4 new command IDs added to
the integration `EXPECTED_COMMANDS`.

```
npm run test:unit         → Test Files 25 passed (25); Tests 307 passed (307)
npm run test:integration  → 4 passing (command registration + openEditor)
npm run build             → type-check + bundle clean
```

Reviewed via `/simplify` (cast → `kind` discriminant narrow; parallelized the
two independent profile reads) and `/code-review` (added ADR-0026 error
surfacing to the checkbox handler). All gates green after each change.

