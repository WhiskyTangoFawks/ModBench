# Mod List View (Loadout) — UI Specification

This document specifies the Loadout view: the Mod Management context's primary surface. It is a VS Code `TreeView` that installs, orders, enables, and deploys mods for the active profile. It operates on mods and files, never on records or FormKeys.

Editing context UI is in [`docs/UI_SPEC.md`](../../../../docs/UI_SPEC.md).

---

## 1. Header

- **Title**: "MODS"
- **Description** (subtitle): current profile name (e.g. "Default")
- **Count** (first non-interactive root node): "247 active / 312 installed"
- **Icon buttons** (left → right): Filter (magnifier), Switch Profile, Launch mEdit, Collapse All, Refresh

**Launch mEdit** switches the sidebar from the Loadout view to the mEdit (Editing) view, lazily spawning the backend if needed (Modbench-5). Deploy and Purge buttons are added here in Modbench-4 (standalone mode only).

---

## 2. Tree Structure

```
MODS — Default
│
│  [count node: 247 active / 312 installed]
│
├── [✓] Ungrouped Mod A          v1.0     ← root-level (no separator)
├── [✓] Ungrouped Mod B          v2.3
│
├── ▼ F4SE - Core & Performance           ← separator node (collapsible)
│   ├── [✓] F4SE                 v0.6.23
│   ├── [✓] Addictol             v1.2
│   └── …
│
└── ▼ F4SE - Fixes
    ├── [✓] Crafting Highlight   v1.6.6
    └── …
```

Ungrouped mods (before the first separator in `modlist.txt`, or between no separators) appear as root-level items above all separator nodes. They are not wrapped in a synthetic container.

Separator nodes are expanded by default. Dragging a separator moves it and all its children as a block, preserving their relative order.

---

## 3. Mod Row Anatomy

| Element | Content |
| --- | --- |
| Checkbox | Enable/disable (`checkboxState`); writes `+`/`-` prefix to `modlist.txt` immediately |
| Label | Mod name (full) |
| Description | Version from `meta.ini`; blank if absent |
| Icon | Generic mod icon (Modbench-3 adds status overlay: ⚠ conflict, ✗ missing master, ↓ update) |
| Tooltip | Full mod name · version · Nexus ID · archive filename |

---

## 4. Filter

Magnifier button in the header reveals a filter input. The input matches mod name and separator name (case-insensitive substring).

A toggle button beside the filter input controls separator behaviour:

- **Toggle on** (default): separators with matches auto-expand; empty separators hide. Matching mods shown in their section context.
- **Toggle off**: flat list of matching mods; all separators hidden.

The toggle resets to on when the filter is cleared. It is not persisted between sessions.

---

## 5. Profile Selector

"Switch Profile" icon button in the header opens a VS Code quick-pick listing all directories under the instance's `profiles/` folder. Selecting one:

1. Persists `selected_profile` in `ModOrganizer.ini`
2. Refreshes the tree (new session boundary; backend session teardown is Modbench-5)

The current profile name is always visible in the tree view description.

---

## 6. Context Menus

**Mod** (`contextValue: "mod"`):

| Action | Condition | Notes |
| --- | --- | --- |
| Open in Explorer | Always | Reveals `mods/<name>/` in VS Code file explorer sidebar |
| Add Separator Below | Always | Quick-input for separator name; inserts immediately below this mod |
| Move to Separator | Always | Quick-pick of separator names + "Ungrouped"; moves mod to end of selected section |
| Uninstall | Always | Confirmation prompt; removes `mods/<name>/` and `modlist.txt` entry |
| View on Nexus | Nexus ID present in `meta.ini` | Opens Nexus page in browser |

**Separator** (`contextValue: "separator"`):

| Action | Notes |
| --- | --- |
| Rename | Quick-input prompt; updates separator line in `modlist.txt` immediately |
| Add Separator Below | Quick-input for name; inserts below this separator (after its last child) |
| Delete Separator | Removes separator line only; mods become ungrouped (promoted to root level or prior separator) |

---

## 7. Write Behaviour

All mutations (enable/disable, drag-reorder, separator create/rename/delete, Move to Separator) write to `modlist.txt` immediately via the active `IModlistSource`. There is no explicit save/discard flow in the Mod List view.

---

## 8. mEdit View Header (Editing context, Loadout-facing)

The mEdit (Editing) view header includes a **Close** icon button that switches the sidebar back to the Loadout view and tears down the backend session (Modbench-5).
