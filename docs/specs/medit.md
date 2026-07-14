# mEdit — Surface Specification

Editing context — operates on **records**, **FormKeys**, and **plugins** (physical
`.esp`/`.esm`/`.esl` files loaded by the backend); the Mod-Management vocabulary ("mod",
"loadout", "deploy") belongs to the sibling surfaces, not here
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

Placement: [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md) — native VS
Code views (sidebar trees + editor-tab webviews), not a custom panel switcher. The
Loadout surface that launches this one is specified in [mods.md](mods.md); the planned
Mod-Management Plugins load-order tree — a *different* "Plugins" surface — in
[plugins.md](plugins.md).

**Vocabulary note:** the mEdit "Plugins tree" here is the entry point into per-record
browsing and requires a spawned backend; it is distinct from the Mod-Management **Plugin
List** ([plugins.md](plugins.md)), which manages `plugins.txt` load order and runs without
the backend. Both display as "Plugins" but are visible in mutually exclusive view modes and
stay fully distinct in code.

## Problem Statement

A mod author building a loadout needs to see what each plugin actually declares, understand
how overrides across plugins interact, and edit records — but the established tool for this
(xEdit) is a standalone Windows application, disconnected from where the loadout is managed.
Conflicts between plugins are the crux of patching: a modder needs to know, for a given
record and field, which plugin wins, which lost an override, and whether an apparent
conflict is a real disagreement or an identical duplicate — and then make a targeted edit
that stages cleanly and writes back to the right physical file. Without an integrated
editor, they leave their loadout tool, load a separate program, hand-correlate what it
shows against their mod list, and edit blind to the loadout context.

## Solution

The **mEdit view** — a set of native VS Code surfaces driven by a lazily-spawned C# backend
session over the active loadout:

- a **Plugins tree** (sidebar) as the entry point for all navigation, browsing each
  plugin's records — including a spatial worldspace/interior-cell tree — plus a Conflicts
  node;
- a **Pending Changes tree** (sidebar, below it) showing in-flight staged operations;
- a **Record editor panel** (editor-tab webview) presenting a per-field, per-plugin
  **compare grid** with conflict color-coding, in-place editing that stages pending
  changes, and a companion **Referenced By** panel;
- a **status bar item** reporting backend/session state.

**Launch mEdit** (from the Loadout header) switches into editing mode, spawns the backend,
and builds the session from the active modlist's enabled plugins plus vanilla masters
(`load-explicit`); **Close mEdit** switches back and tears the session down. Editing writes
records straight to their physical plugin files and never requires a deploy.

## User Stories

1. As a mod author, I want to enter editing mode from my loadout with a single action, so
   that the editor opens against exactly the plugins my active profile loads, with no
   separate session-setup step.
2. As a user, I want a status bar item that tells me whether the backend is running,
   connecting, attached, or has a session loaded (and for which game, with a plugin count),
   so that I always know the editor's state.
3. As a user, I want clicking the status bar item when the backend isn't running to tell me
   how to start it, so that I'm not stuck guessing.
4. As a user, I want a Plugins tree listing every loaded plugin as my entry point, so that
   all navigation starts from one place.
5. As a user, I want to select multiple tree nodes with Ctrl/Shift-click and run a batch
   action (e.g. Remove Record) across the whole selection, so that I can act on many
   records at once, even across different plugins.
6. As a user, I want a filter that narrows the top-level plugin nodes by filename as I type,
   so that I can find a plugin without scrolling — the same filter widget every other
   Modbench list surface uses.
7. As a user, I want to expand a plugin and see its record types, then its records
   (paginated, with a "Load more…" step), so that browsing a large plugin stays responsive.
8. As a user, I want each record labeled with its EditorID and FormKey (or just the FormKey
   when it has no EditorID), so that I can recognize records the way I do in xEdit.
9. As a user, I want vanilla, DLC, and immutable plugins marked with a lock icon and their
   editing actions hidden, so that I can't accidentally try to modify a read-only plugin.
10. As a user, I want a Conflicts node showing records that conflict across plugins, so that
    I can go straight to what needs patching.
11. As a user, I want a conflict badge overlaid on any record node that has a conflict or a
    lost change, so that I can spot trouble while browsing.
12. As a user, I want to browse a plugin's worldspaces and interior cells spatially — down
    through blocks, sub-blocks, cells, and their persistent/temporary placed references — so
    that I can navigate the world the way it's actually laid out, seeing only what *that*
    plugin declares rather than a cross-plugin winner.
13. As a user, I want to open a record by single-clicking its node, so that inspecting a
    record is immediate.
14. As a user, I want a record editor that shows one column per plugin containing this
    record, in load order (master on the left, winning override on the right), so that I can
    compare every plugin's version of the record side by side.
15. As a user, I want each field's cells color-coded to show which plugin wins, which lost
    an override, which merely duplicates the master, and which genuinely disagree, so that I
    can read a conflict at a glance instead of diffing by eye.
16. As a user, I want the row background to summarize the record's overall conflict state
    (no conflict, harmless override, real conflict, critical/injected conflict), so that I
    can triage records without opening every field.
17. As a user, I want enums and flags rendered as their names, never raw integers, so that I
    can read values without a lookup table.
18. As a user, I want a FormKey field to render as the referenced record's EditorID as a
    hyperlink, and clicking it to open that record, so that I can follow references without
    copying IDs around.
19. As a user, I want structs and arrays shown collapsed with a summary and expandable to
    their sub-fields/elements, so that a complex record stays readable.
20. As a user, I want to enter edit mode and change a field with the right input for its
    type (text, number, toggle, dropdown, flag multi-select, FormKey picker), so that
    editing is type-appropriate and I can't enter a nonsensical value.
21. As a user, I want my edits shown as pending changes (highlighted, with a per-field
    revert) rather than written immediately, so that I can review a batch before committing
    and back out a single field.
22. As a user, I want a pending column to appear for a plugin with staged changes, so that I
    can compare my in-progress edit against every existing version.
23. As a user, I want to collapse a plugin column to just its header chip, with the state
    remembered, so that I can focus the grid on the plugins I care about.
24. As a user, I want a column-header menu to copy a plugin's whole record into my editable
    plugin as pending changes, copy it as a new record, or stage removal of that plugin's
    override, so that common override operations are one action.
25. As a user in edit mode, I want to drag a value from one plugin's column into another to
    copy it as a pending change, so that reconciling a conflict is direct manipulation.
26. As a user, I want to save my pending changes (writing every plugin that has them),
    revert all changes for the record, or copy the current values into another plugin, so
    that I control exactly what gets written and where.
27. As a user, I want to rename a record's FormID in edit mode, with validation that the new
    id is free and that immutable references don't block it, so that renumbering is safe and
    the errors are explained rather than silent.
28. As a user, I want a read-only view of a record's Papyrus (VMAD) script data — scripts,
    their properties, and nested array/struct/structList values — so that I can inspect
    scripting without it being editable (editing Papyrus is out of scope).
29. As a user, I want a "Referenced By" panel listing every record that points a FormLink at
    this one, grouped so that multiple plugin overrides of the same referencer collapse into
    one entry, so that I can see what would break if I changed or removed this record.
30. As a user, I want to open a referencing record from that panel — in the active pane or
    beside it — so that I can trace a reference chain quickly.
31. As a user, I want to filter the record tree by a SQL query against the backend's
    per-type tables (returning `form_key`), pruning plugins and record types with no
    matches, so that I can slice the loadout by any condition I can express (conflict
    status, EditorID search, record type) without a fixed toggle UI.
32. As a user, I want to save filters as `.sql` files, apply one from a picker or from an
    inline Code Lens on the file, and see which filter is active, so that my useful queries
    are reusable and obvious.
33. As a user, I want a built-in "pending changes" filter preset, so that I can immediately
    narrow the tree to records I've touched.
34. As a user, I want a Pending Changes tree listing my in-flight staged operations (create,
    delete, renumber) with a description and change/plugin counts, so that I can see and
    manage work that spans multiple records.
35. As a user, I want to save or revert a single change group, or all of them at once, so
    that I can commit related edits as a unit.
36. As a user, I want a partial-save failure (some plugins saved, some not) reported clearly
    with the group left intact and its unsaved changes re-queued, so that a failure never
    silently loses my work.
37. As a user, I want to create a new plugin, add a record to a plugin, copy a record as an
    override or as a new record into another plugin, and remove records (with a confirmation
    that lists everything selected), so that the common authoring operations are all in the
    tree.
38. As a user, I want to open a plugin's header as a first-class record by clicking the
    plugin node — viewing its author, masters, and flags in a single-column panel, and (on
    editable plugins) editing them through pending changes: set the author, toggle ESL/ESM
    (rejected at stage time when the plugin isn't ESL-eligible), and add a master chosen from
    the loaded plugins (validated so I can't make the plugin unloadable) — so that
    maintaining a plugin's header is staged and reviewable like any other edit. *(Multi-step
    form-space operations — compact FormIDs, copy-as-underride, merge, and sort/clean/remove
    masters — are deferred, delivered later as Python scripts over these primitives, not
    bespoke commands.)*
39. As a user, I want to create and manage placed references (REFR/ACHR) inside a cell's
    persistent or temporary group, so that I can edit world placement spatially.
40. As a user, I want to run a script against the whole session or a specific record/plugin
    (planned), so that I can automate repetitive edits.
41. As a user, I want all of these actions reachable from the command palette as well as the
    tree, so that I can drive the editor by keyboard.
42. As a user, I want null/missing fields shown as empty cells (never "null"/"undefined")
    and read-only cells in immutable columns to render no input on click, so that the grid
    reads cleanly and never invites an edit that can't happen.

## Implementation Decisions

### Scope & overall layout

- This spec covers the **mEdit view's frontend surfaces** and the behavior they present.
  The backend endpoint contract that drives them is governed by
  `MEditService/CLAUDE.md` and the generated API client, not restated here.
- Modbench is a single activity-bar container (`modbench`). A `modbench.viewMode` context
  key toggles the sidebar between the Loadout surface and this mEdit surface. **Launch
  mEdit** (in the Loadout header) switches to editing mode, lazily spawning the backend and
  loading the active modlist as the session; **Close mEdit** switches back and tears the
  session down.
- The mEdit view is composed of four surfaces: the **Plugins tree** (sidebar entry point),
  the **Pending Changes tree** (sidebar, below it), the **Record editor panel** (editor-tab
  webview, one per open record), and the **status bar item**. There is no toolbar or
  top-level menu bar — every action is reachable from a tree context menu, the command
  palette, or the record editor panel itself.

### Status bar

- A bottom-right item reflects backend/session state: **not running** ("backend not
  running", warning color), **connecting**, **attached with no session**, and **attached
  with a session** ("{GameRelease} — {N} plugins", success color).
- Clicking it while the backend is not running shows start-up instructions. Sessions are
  created via **Launch mEdit** from the Loadout surface, never from the status bar.

### Plugins tree (navigation)

- A `TreeView` (`modbench.pluginTree`, "Plugins"), visible while
  `modbench.viewMode == 'editing'`. It is the primary navigation surface; there is no
  separate load-session step — the session is constructed on entry from the active
  modlist's enabled plugins plus vanilla masters (`load-explicit`).
- **Multi-select** (`canSelectMany`): Ctrl/Shift-click selects multiple nodes, possibly
  spanning plugins and record types; batch-capable context commands (currently Remove
  Record) receive the full selection.
- **Plugin-name filter**: a title-bar magnifier opens a transient `InputBox` that
  live-filters the top-level plugin nodes by case-insensitive filename substring; dismissing
  it restores the full list. This is the shared cross-surface filter convention (Mods tree,
  Downloads, Plugin List, and here). It is a **distinct axis** from the record filter below:
  this narrows *which plugins* appear; the record filter narrows *which records* appear
  under a plugin. The two compose.
- **Top-level nodes**: one node per loaded plugin (children: Worldspaces + Interior Cells
  group nodes plus flat record-type nodes), and a lazy-counted **Conflicts** node listing
  conflict records. `WRLD`/`CELL`/`REFR`/`ACHR` are shown spatially (below) and hidden from
  the flat record-type list.
- **Plugin nodes**: labeled by filename, with a **lock icon on immutable plugins**. An
  **Open Header** action (context menu; also available inline) opens the plugin's **header
  record** — author, masters, flags — as a single-column record panel. Their context menu
  exposes New Plugin…, Copy as Override Into…, Open Header, and — on editable plugins only —
  Add New Record…, Convert to ESL/ESM, Add Master…, and Run Script…. Each is a confirmation
  or picker as appropriate; destructive ones confirm. (Compact FormIDs, copy-as-underride,
  merge, and sort/clean/remove masters are deferred to Python scripts — see Out of Scope.)
- **Record-type nodes**: labeled by type; children are paginated record nodes with a "Load
  more…" node at the end of a page.
- **Record nodes**: labeled `{EditorID}  [{RecordType}:{FormID}]` (FormKey only when no
  EditorID), with a conflict badge overlaid when the record conflicts or has a lost change.
  Single-click (or Open Record) opens the editor; the context menu adds Copy as Override
  Into…, Copy as New Record Into…, Remove Record (a confirmation listing every selected
  record, deleting the whole selection as one batch; the Delete key also triggers it), Show
  Referenced By, and Run Script… (context = this record).

### Record filter (SQL)

- The record tree is filtered by a **filter file** — a plain `.sql` file containing a DuckDB
  `SELECT` returning `form_key`. While active, the tree is pruned: plugins and record types
  with no matching records are hidden ([ADR-0018](../adr/0018-sql-file-based-record-filter.md)).
- Entry points: a tree title-bar funnel (opens a `setFilter` quick pick of `.sql` files in
  `modbench.scriptsPath` plus "New filter…"), a funnel-slash to clear (shown only while a
  filter is active), command-palette equivalents, and **Code Lens** on open `.sql` files
  under `modbench.scriptsPath` ("▶ Apply as Filter" when the file differs from the active
  filter; "✓ Active — click to clear" when it is the active filter). A `filterActive`
  context key drives the active indicators.
- Conflict-status filtering, EditorID search, and record-type narrowing are all expressed as
  user-written SQL against the per-type DuckDB tables — **no structured toggle UI**. A
  built-in `pending-changes.sql` preset (`SELECT DISTINCT form_key FROM pending_changes`) is
  copied into `modbench.scriptsPath` on first use.

### Worldspace / interior-cell tree

- **Per-plugin**, under each plugin node: "Worldspaces" and "Interior Cells" group nodes
  show what *that plugin* declares (records and overrides), never a cross-plugin winner.
  Placed records (REFR/ACHR) are indexed; parentage lives in `placement` / `cell_location`
  side tables ([ADR-0023](../adr/0023-placed-objects-indexed-with-placement-side-tables.md)).
- The spatial hierarchy descends Worldspace → Block → Sub-block → Cell (by XCLC coordinates)
  → Persistent/Temporary placed-reference groups → placed references. Block and Sub-block
  nodes are grouping-only (no record, no click); clicking a CELL or REFR node opens the
  editor.
- Context menus: a **placed group** offers Create Placed… (quick pick REFR/ACHR + optional
  template FormKey); a **placed reference** offers Copy as Override Into… and Delete (the
  same handlers as elsewhere). CELL nodes have no menu.

### Record editor panel

- A webview panel opened by `modbench.openEditor`; **one panel at a time**, reused when
  navigating between records (an extension invariant). It is a React app.
- **Header**: record identity (`{RecordType} / {EditorID}`, or FormKey) and the FormKey
  (`{FormID}:{OriginPlugin}`) as plain text in view mode. In edit mode the FormID becomes a
  6-hex-char input with a **Renumber** button (enabled only when the value changed and the
  record is mutable); renumber stages a change group. An in-use FormID surfaces an inline
  error; an immutable-reference block surfaces a notification naming the blocking plugins.
- **Compare grid** (the primary view): one **row per field** (fields with no value in any
  plugin hidden by default); one **column per plugin** that contains the record's FormKey,
  in load order (left = master, right = winning override), plus a **Pending** column for any
  plugin with staged changes. Column headers show the plugin name as a chip (lock icon on
  immutable); left-click collapses/expands a column (state persisted in session); right-click
  offers Copy All to Pending, Copy as New Record, and Remove Override (disabled for
  immutable).
- **Cells render by field schema type**: strings/numbers/bools as text/number/toggle inputs
  in edit mode; enums as their name via a `<select>`; flags as active flag names via a
  per-flag multi-select; FormKeys as an EditorID hyperlink (edit: a FormKey picker filtered
  by `validFormKeyTypes`); structs and arrays as a collapsed summary expandable to child
  rows with add/remove. Pending-change cells show the new value on a yellow background with a
  revert (×) button.
- **Editing stages pending changes** rather than writing immediately. Edit mode is entered
  from the toolbar (or by selecting an editable cell); its controls are Save (writes every
  plugin with pending changes), Revert All (drops this record's changes), and Copy to… (a
  plugin picker), plus the per-field revert. In edit mode a cell value can be **dragged
  between plugin columns** to copy it as a pending change into the target (which must be
  editable).

### Conflict color coding

The compare grid uses the two-axis model from
[ADR-0016](../adr/0016-two-axis-conflict-model.md). These two mappings are
kept as tables deliberately — they are enum→visual encodings that prose would only make less
precise.

**Axis 1 — ConflictAll → row background** (one value per record):

| ConflictAll | Row background | Meaning |
| --- | --- | --- |
| OnlyOne, NoConflict | No tint | Only in one plugin, or all overrides agree |
| Override | Subtle green | Overrides exist but no real conflict |
| Conflict | Subtle orange | Overrides disagree on a field |
| ConflictCritical | Subtle red | Injected record (FormKey origin not in a plugin's master list) whose overrides actually differ — content-identical injected records stay NoConflict |

**Axis 2 — ConflictThis → cell background + text color** (computed per-field, per-plugin — a
plugin may be Override on one field and ConflictLoses on another):

| ConflictThis | Cell background | Text color | Meaning |
| --- | --- | --- | --- |
| Master, OnlyOne | None | Default | The master (origin) plugin or only plugin |
| IdenticalToMaster | Grey | Default | Override present but field unchanged |
| Override | Green | Default | Changed from master; no other plugin disagrees |
| ConflictWins | Orange | Default | Disagrees with another override; this plugin wins |
| ConflictLoses | Red | Red | Disagrees with another override; this plugin's value was overridden |

Absent fields (a null value in a non-master plugin — the PartialForm absent-field rule)
render with no background and no text color. Column headers use the worst ConflictThis across
that plugin's fields as a quick summary; individual cell colors are authoritative.

### VMAD (Papyrus) section

- When a record's compare response includes VMAD data, a **read-only** "Scripts (VMAD)"
  section renders below the field rows in the same table body; it is absent for record types
  without VMAD. **Editing Papyrus is out of scope** — this section never renders inputs.
- Two expandable levels: **script rows** (bold script name; per-plugin script flag; blank
  for plugins lacking the script; collapsed by default) and indented **property rows**
  (per-plugin value; hidden while the parent script is collapsed).
- Container-kind properties (array, struct, structList) are themselves collapsible with a
  summary badge when collapsed, expanding to element/member child rows; scalar and
  object/variable kinds are leaf values. A cell is **blank** when the plugin has no value for
  the property, versus an em-dash `—` when the property exists but is empty for that plugin.
  Object-kind values render as FormKey link-buttons that open the referenced record; when
  property types differ across plugins each cell appends `(TypeName)` in dimmed text.
- Conflict coloring follows the same ConflictThis rules as the field rows, driven by
  per-plugin `cellStates`. In edit mode a VMAD cell can be dragged between columns to copy
  its value as a pending field change (target must be editable).

### Referenced By panel

- A **separate** webview panel (not a tab in the record editor), titled
  `"Referenced By: {EditorID}"` (or FormKey), opened from a record node's Show Referenced By
  or a header button, alongside the record panel (`ViewColumn.Beside`). It lazy-loads its
  references only when first opened.
- It lists records holding a FormLink to this record, **grouped by (FormKey, RecordType)** so
  multiple plugin overrides of the same referencer collapse into one group. A group header
  shows `{RecordType} / {EditorID}` and a plugin count (omitted when one); left-click opens
  that record in the active pane, right-click offers "Open to the Side". Expanded child rows
  show each holding plugin and field path (informational, not clickable). Empty state: "No
  references found."

### Pending Changes tree

- A second sidebar `TreeView` below the Plugins tree, always visible, showing all in-flight
  ChangeGroups (create/delete/renumber). Each row is labeled `{operation} — {description}`
  with a `{N} changes · {P} plugins` detail line and inline Save/Revert buttons; title-bar
  Save All / Revert All act on every group in sequence (hidden/disabled when none are
  active). Rows are not expandable (per-change detail is a future enhancement).
- Empty state: "No pending changes." **Partial-save failure** (some plugins saved,
  some not) shows an error notification naming which saved and which failed; the group stays
  in the tree with its re-queued changes intact.

### Command palette

- All `modbench.*` commands are available in the palette; `package.json`'s
  `contributes.commands` is the canonical registry. Navigation/workflow commands include
  Launch mEdit (enter editing; spawn backend; load the session), Close mEdit (return to
  Loadout; tear down), Reload Session (refresh the tree), Open Editor (internal; also bound
  to tree click), New Plugin…, Copy as Override Into…, and Run Script… (planned; context =
  the active record if a panel is open, else global).

### Field type rendering rules

These apply everywhere a field value is rendered (the compare grid, pending cells, and any
future surface):

1. **Never display raw integers for enums or flags** — always resolve to name(s).
2. **FormKeys render as EditorID hyperlinks** when the referenced record is indexed; fall
   back to the FormKey string otherwise.
3. **Structs and arrays are always collapsible**, default collapsed; expand state is
   per-session, not persisted across restarts.
4. **Pending values** always show the new value (not the old), on a yellow background with a
   revert button.
5. **Null / missing fields** render as an empty cell, never "null"/"undefined".
6. **Read-only cells** in immutable plugin columns are never editable and render no input on
   click.

### Architecture / seams

- **The backend is the seam for record data and mutations**: the frontend talks to it only
  through the generated API client; the compare grid, conflict states, references, and all
  mutations are behaviors of endpoints owned by `MEditService/`. The frontend holds
  rendering and staging logic, not record semantics.
- **Conflict classification** (the two-axis ConflictAll/ConflictThis model,
  [ADR-0016](../adr/0016-two-axis-conflict-model.md)) is
  computed backend-side and consumed by the grid as `cellStates` — the frontend maps states
  to color, it does not derive them.
- **The webview React app** is the client-side surface under test for rendering rules
  (enum/flag names, FormKey links, collapsibility, pending highlighting) and for staging
  behavior (pending changes, per-field revert), independent of the backend.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — for the webview
  that means: given a compare response, assert what the grid renders (rows/columns, per-cell
  color from `cellStates`, enum/flag names resolved, FormKey links, pending highlighting);
  given a staging interaction, assert the pending state and the save/revert payloads. No
  assertions about private component internals.
- **Record semantics and conflict classification** are the backend's responsibility and are
  tested there (see `MEditService/CLAUDE.md`), not re-asserted from the webview; the frontend
  tests consume representative compare responses as fixtures.
- **Integration seam** (`npm run test:integration`, real VS Code process): the Plugins tree
  builds from a session, navigation opens a record panel, the record filter prunes the tree,
  the Pending Changes tree reflects staged operations, and command registration holds — add
  any new command id(s) to `EXPECTED_COMMANDS` (per `modbench/CLAUDE.md`).

## Out of Scope

- **Multiple simultaneous record editor panels** — one panel is open at a time and reused
  when navigating (an extension invariant).
- **A structured conflict/EditorID/record-type filter UI** — filtering is deliberately
  user-written SQL against the per-type tables, not a fixed toggle set (ADR-0018).
- **Expandable per-change detail in the Pending Changes tree** — rows show counts only; drilling
  into individual changes is a future enhancement.
- **Run Script…** across session/record/plugin — planned, not yet shipped.
- **Delta / overlay editing** — loading an arbitrary overriding-plugin set side-by-side is a
  Loadout-adjacent concern (see [mods.md](mods.md) Out of Scope); deferred.
- **Multi-step form-space operations** — compact FormIDs, copy-as-underride (moving a record
  down into a master), merge-into-another-plugin, and sort/clean/remove masters — are
  deferred and will be delivered as Python scripts over the header/renumber/copy/delete
  staging primitives, not bespoke commands. They compose from those primitives and are
  inherently multi-step (a masters reorder remaps every FormID's master index; clean requires
  whole-plugin reference analysis). Near-term header editing (author, ESL/ESM flag, add
  master) is a first-class feature — see User Story 38.

## Further Notes

- This surface is the **only** one that requires the C# backend; the Mod-Management surfaces
  ([mods.md](mods.md), [downloads.md](downloads.md), [plugins.md](plugins.md)) all run
  without it. The backend lifecycle (spawn on Launch mEdit, teardown on Close mEdit / profile
  switch / workspace close, restart on crash) is owned by the extension per
  [ADR-0022](../adr/0022-extension-owns-backend-lifecycle.md) and specified from the Loadout
  side in [mods.md](mods.md).
- The Editing "Plugins tree" and the Mod-Management "Plugin List" ([plugins.md](plugins.md))
  both display as "Plugins" but are distinct views (`modbench.pluginTree` vs
  `modbench.pluginListTree`), visible in mutually exclusive view modes — see the Vocabulary
  note at the top and [CONTEXT-MAP.md](../../CONTEXT-MAP.md).
