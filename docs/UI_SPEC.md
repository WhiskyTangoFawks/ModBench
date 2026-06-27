# mEdit — Functional UI Specification

This document is the canonical description of mEdit's frontend surfaces. Each section describes what is shown, what interactions are available, and what data drives them. Implementation phases should be designed against this spec; when a phase changes the intended behavior, update this document first.

---

## Overall Layout

mEdit is a VS Code extension. Its UI is composed of three surfaces:

1. **Sidebar tree** (VS Code activity bar panel) — the entry point for all navigation
2. **Record editor panel** (VS Code editor tab, webview) — the main work surface; one tab per open record
3. **Status bar item** — backend connection state; bottom of VS Code window

There is no toolbar or top-level menu bar. All actions are reachable from the sidebar tree context menu, the command palette, or the record editor panel itself.

---

## 1. Status Bar

The status bar item sits in the bottom-right of the VS Code window.

| Backend state | Label | Color |
|--------------|-------|-------|
| Not running | "mEdit: backend not running" | warning (yellow) |
| Connecting | "mEdit: connecting…" | default |
| Attached, no session | "mEdit: no session" | default |
| Attached, session loaded | "mEdit: {GameRelease} — {N} plugins" | success (green) |

Clicking the item when the backend is not running shows a notification with instructions to start it. Clicking when attached opens the session wizard if no session is loaded, or does nothing if a session is already active.

---

## 2. Sidebar Tree

The sidebar tree is the primary navigation surface. It is a VS Code `TreeView` registered under the `mEdit` view container.

### 2.0 Multi-Select

The tree view has `canSelectMany: true`. Ctrl+click and Shift+click select multiple nodes. Context menu commands that support batch operation (currently: Remove Record) receive the full selection as their second argument. Selection may span different plugins and record types.

### 2.1 Top-Level Nodes

When no session is loaded:
- Single informational node: "No session — click to load…"; activating it runs `mEdit.loadSession`.

When a session is loaded, top-level nodes are:

| Node | Label | Children |
|------|-------|---------|
| Plugins | One node per loaded plugin | "Worldspaces" + "Interior Cells" nodes (Phase 16) + record type nodes |
| Conflicts | "Conflicts ({N})" — lazy-loaded count | Conflict record nodes (Phase 9) |

The worldspace/cell tree is **per-plugin** (under each plugin node), showing what that
plugin declares — its records and overrides — not a cross-plugin winner. `WRLD`, `CELL`,
`REFR`, and `ACHR` are shown spatially (see §2.6) and hidden from the flat record-type list.

### 2.2 Plugin Nodes

Label: `{PluginName}` (e.g. `Fallout4.esm`, `MyMod.esp`)

Icon: lock icon for immutable plugins. No icon for editable plugins.

Context menu (`contextValue: "plugin"` / `"pluginImmutable"`):

| Action | Available on | Notes |
|--------|-------------|-------|
| New Plugin… | Always | Opens name/type picker; calls `POST /plugins/create` |
| Add New Record… | Editable only | Opens type picker; calls `POST /plugins/{plugin}/records` (Phase 10) |
| Copy as Override Into… | Always | Plugin picker; calls copy-to |
| Compact FormIDs | Editable only | Confirmation dialog; calls `POST /plugins/{plugin}/compact-formids` (Phase 14) |
| Convert to ESL / ESM | Editable only | Type picker; calls `POST /plugins/{plugin}/convert` (Phase 14) |
| Add Master… | Editable only | Master name input; calls `POST /plugins/{plugin}/masters/add` (Phase 14) |
| Sort Masters | Editable only | Immediate; calls `POST /plugins/{plugin}/masters/sort` (Phase 14) |
| Clean Masters | Editable only | Confirmation; calls `POST /plugins/{plugin}/masters/clean` (Phase 14) |
| Inject Forms into Master… | Editable only | Confirmation; calls `POST /plugins/{plugin}/records/inject-to-master` (Phase 14) |
| Run Script… | Editable only | QuickPick from `GET /scripts`; calls `POST /script/run` (Phase 15) |
| Merge Into… | Editable only | Target picker; confirmation; calls `POST /plugins/merge` (Phase 14) |

### 2.3 Record Type Nodes

Label: `{RecordTypeName}` (e.g. `NPC_`, `WEAP`, `CELL`)

Context menu: none currently defined.

Children: Record nodes (paginated; "Load more…" node at end of page).

### 2.4 Record Nodes

Label: `{EditorID}  [{RecordType}:{FormID}]` — EditorID first, then FormKey components. If EditorID is absent, show FormKey only.

Conflict badge icon overlaid on node icon when the record has a conflict or change-lost state (Phase 9).

Context menu (`contextValue: "record"`):

| Action | Notes |
|--------|-------|
| Open Record | Default action (also triggered by single click); runs `mEdit.openEditor` |
| Copy as Override Into… | Plugin picker; calls copy-to |
| Copy as New Record Into… | Plugin picker; calls `POST /plugins/{plugin}/records` with template (Phase 10) |
| Remove Record | Confirmation dialog listing all selected records; calls `POST /records/delete` with all selected `(FormKey, Plugin)` pairs as one batch (Phase 10); Delete key also triggers this when record nodes are selected |
| Show Referenced By | Opens record editor on the "Referenced By" tab (Phase 11) |
| Run Script… | Context is this record; QuickPick from `GET /scripts` (Phase 15) |

### 2.5 Record Filter (Phase 9.6)

The record tree is filtered by a **filter file** — a plain `.sql` file containing a DuckDB SELECT that returns `form_key`. While a filter is active, the tree is pruned: plugins and record types with no matching records are hidden.

**Entry points:**

- Tree view title bar: funnel icon button (always visible) → opens `mEdit.setFilter` QuickPick; funnel-slash icon (visible only when filter active) → `mEdit.clearFilter`
- Command palette: `mEdit.setFilter`, `mEdit.clearFilter`
- Code Lens on open `.sql` files in `mEdit.scriptsPath` (see below)

**`mEdit.setFilter` QuickPick:**

Lists all `.sql` files in `mEdit.scriptsPath` plus a "New filter…" option. Selecting a file POSTs its SQL to the backend and refreshes the tree. "New filter…" opens a new untitled `.sql` editor tab.

**Code Lens on `.sql` files:**

Two inline lenses appear at the top of every `.sql` file under `mEdit.scriptsPath`:

- `▶ Apply as Filter` — when the file's content does not match the currently active filter SQL
- `✓ Active — click to clear` — when this file is the active filter

An editor title bar funnel-slash button is also shown when any filter is active.

**Active filter indicator:** the tree title bar funnel icon and the editor title bar button both reflect active/inactive state via the `mEdit.filterActive` VS Code context key.

**Clearing the filter** restores the full unfiltered tree.

**Built-in presets** (copied to `mEdit.scriptsPath` on first use):

| File | SQL |
|------|-----|
| `pending-changes.sql` | `SELECT DISTINCT form_key FROM pending_changes` |

Conflict-status filtering, EditorID search, and record-type narrowing are all expressed as user-written SQL against the per-type DuckDB tables. No structured toggle UI is provided. See ADR-0018.

### 2.6 Worldspace/Interior Cell Tree (Phase 16)

Per-plugin, under each plugin node sit "Worldspaces" and "Interior Cells" group nodes that
show what *that plugin* declares (records and overrides), never a cross-plugin winner.
Placed records (REFR/ACHR) are indexed; parentage lives in `placement` / `cell_location`
side tables (ADR-0023). Under the plugin's "Worldspaces" node:

```
Worldspaces
  └─ SomeWorld [WRLD:000007]
       └─ Block (0, 0)
            └─ Sub-block (0, 0)
                 └─ Cell (12, -5)   ← XCLC coordinates
                      ├─ Persistent
                      │    └─ barrelRef [REFR:001234]
                      └─ Temporary
                           └─ npcRef [REFR:002345]
```

Block and Sub-block nodes are grouping nodes only (no record, no click action). Clicking a CELL or REFR node opens the record editor.

**Context menu actions on worldspace/cell nodes (Phase 16.2.4):**

| Node | contextValue | Actions |
| ---- | ------------ | ------- |
| CellNode | `cell` | *(none)* |
| PlacedGroupNode | `placedGroup-persistent` / `placedGroup-temporary` | **Create Placed…** — QuickPick REFR/ACHR + optional template FormKey; calls `POST /plugins/{plugin}/cells/{cellFormKey}/placed` |
| PlacedNode | `refr` | **Copy as Override Into…** (same handler as `mEdit.copyAsOverrideInto`); **Delete** (same handler as `mEdit.deleteRecord`) |

---

## 3. Record Editor Panel

The record editor is a VS Code webview panel opened by `mEdit.openEditor`. One panel can be open at a time (reused when navigating between records — see extension invariant). The panel is a React app.

### 3.1 Panel Header

- Record identity: `{RecordType} / {EditorID}` (or FormKey if no EditorID)
- FormKey display: `{FormID}:{OriginPlugin}` — always visible in view mode as plain text

**FormID rename (Phase 10.4):** In edit mode, the FormID portion (`{FormID}`) becomes an `<input type="text">` constrained to 6 hex characters. The `:{OriginPlugin}` suffix is displayed adjacent, non-editable. A "Renumber" button appears beside the input; it is disabled until the hex value differs from the current FormID and enabled only when the record belongs to a mutable plugin. Clicking "Renumber" calls `POST /records/{formKey}/renumber` and stages a ChangeGroup. On 422 (FormID in use), an inline error appears below the input: "FormID `{value}` is already in use". On 409 (immutable reference blocks rename), a notification lists the blocking plugins.

### 3.2 Fields Tab — Compare Grid

The compare grid is the primary view. Layout:

- **Rows**: one per field. Fields without any value across all plugins are hidden by default.
- **Columns**: one per plugin that contains this record's FormKey. Plugins appear in load order (left = lowest / master, right = highest / winning override). An additional "Pending" column appears for any plugin with staged changes.

#### Column Header

Displays plugin name as a chip. Immutable plugins show a lock icon.

**Interactions:**
- Left-click: collapse/expand the column (collapsed = chip only, no cell content). Collapsed state persisted in session.
- Right-click: context menu (Phase 17):
  - "Copy All to Pending" — copies all field values as pending changes into the active editable plugin
  - "Copy as New Record" — copies as a new record pending change
  - "Remove Override" — stages deletion of this plugin's override (Phase 10; disabled for immutable)

#### Field Rows

Each row:

| Sub-column | Content |
|-----------|---------|
| Field name | Label derived from Mutagen property name (e.g. "Height", "Race", "Keywords") |
| Plugin cells | One cell per plugin column |

Conflict color coding applied to the entire row background and to individual cells (see §3.3).

#### Cell Types (by field schema `type`)

| Schema type | Read mode | Edit mode |
|-------------|-----------|-----------|
| `string` | Plain text | `<input type="text">` |
| `int` / `float` | Number | `<input type="number">` |
| `bool` | "Yes" / "No" | Toggle / checkbox |
| `enum` | Enum name (not raw integer) | `<select>` with option per `enumValues` entry |
| `flags` | Comma-separated active flag names | Multi-select dropdown with per-flag checkboxes |
| `formKey` | EditorID (hyperlink) — clicking opens that record | `<FormKeyPicker>` — search by EditorID, filtered by `validFormKeyTypes` |
| `struct` | Collapsed summary | `<StructRowGroup>` — child rows per sub-field (Phase 12) |
| `array` | "{N} items" | `<ArrayRowGroup>` — child rows per element, add/remove buttons (Phase 12) |

Pending-change cells show the new value with a yellow background and a revert (×) button.

#### VMAD Section (Phase 13.3)

When the record's compare response includes VMAD (Papyrus script) data, a read-only **Scripts (VMAD)** section is rendered below the field rows, inside the same `<tbody>`. It is absent for record types with no VMAD.

**Structure** — two levels of rows, both expandable:

- **Script rows** — bold script name in the label column; per-plugin script flag (e.g. `Local`) per value column; blank for plugins that lack the script. Collapsed by default.
- **Property rows** — indented property name (85% opacity) in the label column; per-plugin property value per value column. Hidden when the parent script is collapsed.

Properties of container kind (array, struct, structList) are themselves collapsible; their collapsed cell shows a summary badge. Expanding reveals child rows for elements or members.

**Property kinds:**

| Kind         | Collapsed cell   | Expanded         |
|--------------|------------------|------------------|
| `scalar`     | leaf value       | —                |
| `object`     | FormKey link     | —                |
| `array`      | `[N items]`      | N element rows   |
| `struct`     | `{…}`            | N member rows    |
| `structList` | `[N structs]`    | N struct rows    |
| `variable`   | `(Variable)`     | —                |

A plugin column cell is blank (no em-dash) when the plugin has no value for that property. An em-dash `—` (opacity 0.35) is shown when the property exists in the record but has no value for that plugin.

**Object-kind FormKey links:** rendered as underlined text buttons (same style as `formKey` field cells). Clicking opens the referenced record in the record editor panel.

**Type cues:** when property types differ across plugins (e.g. one plugin declares `Int32`, another declares `Float`), each cell appends `(TypeName)` in dimmed text.

**Conflict coloring:** follows the same ConflictThis rules as §3.3 — cell background and text color driven by the per-plugin `cellStates` value for each property.

**Read-only:** the VMAD section never renders edit inputs. Editing Papyrus script data is out of scope.

**Drag-drop (Phase 17):** In edit mode, cells can be dragged between plugin columns. Dropping copies the source value as a pending field change into the target column's plugin. Target must be editable.

#### Conflict Color Coding (Phase 9 / Phase 9.7)

The compare grid uses the two-axis model from ADR-0016.

**Axis 1 — ConflictAll → row background color** (one value per record)

| ConflictAll | Row background | Meaning |
|---|---|---|
| OnlyOne, NoConflict | No tint | Only in one plugin, or all overrides agree |
| Override | Subtle green | Overrides exist but no real conflict |
| Conflict | Subtle orange | Overrides disagree on a field |
| ConflictCritical | Subtle red | Injected record (FormKey origin not in a plugin's master list) |

**Axis 2 — ConflictThis → cell background + text color** (computed per-field per-plugin — a plugin may be Override on one field and ConflictLoses on another)

| ConflictThis | Cell background | Text color | Meaning |
|---|---|---|---|
| Master, OnlyOne | None | Default | The master (origin) plugin or only plugin |
| IdenticalToMaster | Grey | Default | Override present but field unchanged |
| Override | Green | Default | Changed from master; no other plugin disagrees |
| ConflictWins | Orange | Default | Disagrees with another override; this plugin is the winner |
| ConflictLoses | Red | Red | Disagrees with another override; this plugin's value was overridden |

Absent fields (null value in a non-master plugin — PartialForm absent-field rule) render with no background and no text color.

Column headers use the per-record ConflictThis aggregate (the worst ConflictThis across all fields for that plugin) as a quick summary; individual cell colors are the authoritative per-field states.

### 3.3 Referenced By Panel (Phase 11)

A separate VS Code webview panel — not a tab inside the record editor. Title: `"Referenced By: {EditorID}"` (or FormKey if no EditorID).

**How to open:** right-click a record node in the sidebar tree → "Show Referenced By"; or a button in the record editor panel header. Opens alongside the record panel (`ViewColumn.Beside`).

Calls `GET /records/{formKey}/references` on mount (lazy — only when the panel is first opened).

Displays a grouped list of records that hold a FormLink pointing to this record. Results are grouped by `(FormKey, RecordType)` — multiple plugin overrides of the same record collapse into one group.

**Group header** (one per unique referencing record):
```
▶  {RecordType} / {EditorID}   (N plugins)
```
- Collapsed by default; expand/collapse toggle per group
- Count omitted when only one plugin holds the reference
- **Left-click**: opens that record in the currently active record panel (`ViewColumn.Active`)
- **Right-click**: context menu → "Open to the Side" (`ViewColumn.Beside`)

**Expanded child rows** (one per plugin override that holds the reference):
```
    {PluginName}   field: {FieldPath}
```
- Indented; informational only — not clickable

Empty state: "No references found."

### 3.4 Edit Mode Controls

Edit mode is entered by clicking "Edit" in the panel toolbar (or selecting an editable cell).

Toolbar buttons when in edit mode:

| Button | Action |
|--------|--------|
| Save | Calls `POST /plugins/{plugin}/save` for all plugins with pending changes |
| Revert All | Calls `DELETE /changes` for this record |
| Copy to… | Plugin picker; copies current field values as override into selected plugin |

Per-field revert (×) button appears on each pending cell.

---

## 4. Change Groups Panel (Phase 10.5)

A second VS Code tree view registered in the mEdit view container, below the plugin/record tree. Displays all in-flight ChangeGroups (create, delete, renumber operations). Always visible; shows an empty state when no groups are active.

### 4.1 Title Bar

Two title bar icon buttons:

| Button | Action |
|--------|--------|
| Save All | Calls `POST /change-groups/{id}/save` for each group in sequence; refreshes tree on completion |
| Revert All | Calls `DELETE /changes/group/{id}` for each group; refreshes tree |

Both buttons are hidden (or disabled) when there are no active groups.

### 4.2 Group Rows

One tree item per ChangeGroup. Label format: `{operation} — {description}` (description omitted if null). Detail line: `{N} changes · {P} plugins`.

Inline action buttons on each row (VS Code tree item buttons):

| Button | Action |
|--------|--------|
| Save | `POST /change-groups/{id}/save`; refreshes tree and plugin/record tree on success |
| Revert | `DELETE /changes/group/{id}`; refreshes tree |

Group rows are not expandable in Phase 10.5. Individual change detail is a future enhancement.

### 4.3 Empty State

When no groups are active: single informational node — "No pending group changes."

### 4.4 Error State

If `POST /change-groups/{id}/save` returns a partial failure (some plugins saved, some did not): show a VS Code error notification naming which plugins saved and which failed. The group row remains in the tree with its re-queued changes intact. See phase-10.5.md for the partial-save failure contract.

---

## 5. Command Palette Commands

All `mEdit.*` commands are available in the command palette. The full list is the canonical registry in `package.json` `contributes.commands`. Commands relevant to navigation and common workflows:

| Command ID | Title | Notes |
|-----------|-------|-------|
| `mEdit.loadSession` | mEdit: Load Session | Runs session wizard |
| `mEdit.openEditor` | mEdit: Open Record Editor | Internal; also bound to tree click |
| `mEdit.newPlugin` | mEdit: New Plugin… | Prompts for name and type |
| `mEdit.copyAsOverride` | mEdit: Copy as Override Into… | Requires active record panel |
| `mEdit.showConflicts` | mEdit: Show Conflicts | Focuses the Conflicts tree node (Phase 9) |
| `mEdit.runScript` | mEdit: Run Script… | QuickPick; context = active record if panel open, else global (Phase 15) |

---

## 6. Field Type Rendering Rules (Summary)

These rules apply everywhere a field value is rendered — in the compare grid, the pending changes panel, and any future surfaces.

1. **Never display raw integers for enums or flags.** Always resolve to name(s).
2. **FormKeys render as EditorID hyperlinks** when the referenced record is in the index; fall back to FormKey string if not resolved.
3. **Structs and arrays are always collapsible.** Default collapsed. Expand state is per-session, not persisted across restarts.
4. **Pending values** always show the new value (not the old), with a yellow background and a revert button.
5. **Null / missing fields** render as an empty cell, not "null" or "undefined".
6. **Read-only cells** in immutable plugin columns are never editable; no input is rendered on click.
