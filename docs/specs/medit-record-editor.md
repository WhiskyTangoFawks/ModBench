# mEdit Record editor panel — Surface Specification

**Status: Implemented**, with two reworks specced and not yet built — the removal of edit mode
(#111) and the Pending column's save/revert actions
([ADR-0029](../adr/0029-pending-changes-tree-is-a-grouping-view.md)). Both are marked *planned*
inline below.

Editing context — operates on **records**, **FormKeys**, **plugins**, and **ChangeGroups**;
the Mod-Management vocabulary ("mod", "loadout", "deploy") belongs to the sibling surfaces, not
here ([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

One of the mEdit view's surfaces — see [medit.md](medit.md) for the shared session lifecycle,
status bar, command palette, and architecture seams. Siblings:
[Plugins tree](medit-plugins-tree.md) (what opens this panel),
[Pending Changes tree](medit-pending-changes-tree.md) (where staged edits are grouped),
[Referenced By panel](medit-referenced-by.md).

## Problem Statement

Conflicts between plugins are the crux of patching. For a given record and field a mod author
needs to know which plugin wins, which lost an override, whether an apparent conflict is a real
disagreement or an identical duplicate — and then make a targeted edit that stages cleanly and
writes back to the right physical file. Answering that by opening plugins one at a time and
diffing by eye does not scale past a couple of overrides, and the values themselves resist
reading: enums and flags are integers, FormKeys are opaque, structs and arrays nest.

The edit itself is dangerous in a way a text editor's is not. A record is referenced by other
records, lives in a file that may be read-only, and may be entangled with edits elsewhere in
the session. An editor that writes on keystroke, or that hides which plugin a value will land
in, produces broken plugins.

## Solution

An editor-tab webview presenting a **compare grid**: one row per field, one column per plugin
containing the record, in load order — master on the left, winning override on the right — with
per-cell conflict color coding from the two-axis model
([ADR-0016](../adr/0016-two-axis-conflict-model.md)). Values render as what they mean (flag
names, EditorID links) rather than as what they are stored as.

Editing is in-place and stages a **pending change** rather than writing; a Pending column
appears beside any plugin with staged edits, and every save/revert acts on a whole ChangeGroup
([ADR-0028](../adr/0028-change-groups-are-derived-dependency-closures.md)).

## User Stories

1. As a user, I want a record editor that shows one column per plugin containing this record,
   in load order (master on the left, winning override on the right), so that I can compare
   every plugin's version of the record side by side.
2. As a user, I want each field's cells color-coded to show which plugin wins, which lost an
   override, which merely duplicates the master, and which genuinely disagree, so that I can
   read a conflict at a glance instead of diffing by eye.
3. As a user, I want the row background to summarize the record's overall conflict state (no
   conflict, harmless override, real conflict, critical/injected conflict), so that I can
   triage records without opening every field.
4. As a user, I want enums and flags rendered as their names, never raw integers, so that I can
   read values without a lookup table.
5. As a user, I want a FormKey field to render as the referenced record's EditorID as a
   hyperlink, and `Ctrl+click` to open that record, so that I can follow references without
   copying IDs around — the same gesture xEdit uses, leaving plain click free to edit.
6. As a user, I want structs and arrays shown collapsed with a summary and expandable to their
   sub-fields/elements, so that a complex record stays readable.
7. As a user, I want to click a field and change it with the right input for its type (text,
   number, toggle, dropdown, flag multi-select, FormKey picker), so that editing is
   type-appropriate and I can't enter a nonsensical value — with no mode to enter first, and
   only the cell I clicked becoming an input, so the grid stays readable.
8. As a user, I want my edits shown as pending changes (highlighted, with an inline revert)
   rather than written immediately, so that I can review a batch before committing and back out
   an edit I regret.
9. As a user, I want a pending column to appear for a plugin with staged changes, so that I can
   compare my in-progress edit against every existing version.
10. As a user, I want to collapse a plugin column to just its header chip, with the state
    remembered, so that I can focus the grid on the plugins I care about.
11. As a user, I want a column-header menu to copy a plugin's whole record into my editable
    plugin as pending changes, copy it as a new record, or stage removal of that plugin's
    override, so that common override operations are one action.
12. As a user, I want to drag a value from one plugin's column into another to copy it as a
    pending change, so that reconciling a conflict is direct manipulation.
13. As a user, I want to save or revert a pending value from here — acting on that change's
    whole ChangeGroup, never on part of one — or copy the current values into another plugin,
    so that I control exactly what gets written and where without leaving the record I am
    working on.
14. As a user, I want clicking a pending value to reveal that change in the Pending Changes
    tree, so that I can get from "what did I change here" to "what else does this drag along"
    without hunting.
15. As a user, I want to rename a mutable record's FormID, with validation that the new id is
    free and that immutable references don't block it, so that renumbering is safe and the
    errors are explained rather than silent.
16. As a user, I want a read-only view of a record's Papyrus (VMAD) script data — scripts,
    their properties, and nested array/struct/structList values — so that I can inspect
    scripting without it being editable (editing Papyrus is out of scope).
17. As a user, I want null/missing fields shown as empty cells (never "null"/"undefined") and
    read-only cells in immutable columns to render no input on click, so that the grid reads
    cleanly and never invites an edit that can't happen.

## Implementation Decisions

### The panel

- A webview panel opened by `modbench.openEditor`; **one panel at a time**, reused when
  navigating between records (an extension invariant). It is a React app.
- **Header**: record identity (`{RecordType} / {EditorID}`, or FormKey) and the FormKey
  (`{FormID}:{OriginPlugin}`). On a mutable record the FormID is a 6-hex-char input with a
  **Renumber** button (enabled only when the value changed); on an immutable one it is plain
  text. Renumber stages a ChangeGroup. An in-use FormID surfaces an inline error; an
  immutable-reference block surfaces a notification naming the blocking plugins.
- **Compare grid** (the primary view): one **row per field** (fields with no value in any
  plugin hidden by default); one **column per plugin** that contains the record's FormKey, in
  load order (left = master, right = winning override), plus a **Pending** column for any plugin
  with staged changes. Column headers show the plugin name as a chip (lock icon on immutable);
  left-click collapses/expands a column (state persisted in session); right-click offers Copy
  All to Pending, Copy as New Record, and Remove Override (disabled for immutable).

### Editing

- **There is no edit mode** *(planned — #111; a header Edit/View toggle ships today and resets
  on every record navigation)*. A cell in a non-immutable column renders as text and swaps to
  its input **on click**, reverting to text on commit or blur — only the clicked cell, never the
  whole grid, since reading conflicts at a glance is the grid's primary job. This is xEdit's
  `toEditOnClick`. Immutable columns never activate an input. Dragging is always available,
  except on a cell whose own input is active.
- **Cells render by field schema type**: strings/numbers/bools as text/number/toggle inputs;
  enums as their name via a `<select>`; flags as active flag names via a per-flag multi-select;
  FormKeys as an EditorID hyperlink — `Ctrl+click` follows it, plain click opens a FormKey
  picker filtered by `validFormKeyTypes`, and the link affordance appears on `Ctrl`-hover only
  when the cell actually links to an indexed record; structs and arrays as a collapsed summary
  expandable to child rows with add/remove. Pending-change cells show the new value on a yellow
  background with a revert (↩) button.
- **Editing stages pending changes** rather than writing immediately. Copy to… (a plugin
  picker) remains a panel-level control. A cell value can be **dragged between plugin columns**
  to copy it as a pending change into the target (which must be editable; the source need not
  be).

### Pending column

*Planned — [ADR-0029](../adr/0029-pending-changes-tree-is-a-grouping-view.md). Today the column
is display-only but for an inline revert, and the panel's Save button calls
`POST /plugins/{plugin}/save`, a route the backend does not implement.*

Every action is scoped to a **ChangeGroup**, never to part of one and never to a record or a
plugin:

- **Plain click** on a pending value reveals that change in the
  [Pending Changes tree](medit-pending-changes-tree.md). The gesture is free because pending
  cells are not editable, and it keeps `Ctrl+click` meaning "follow the reference" uniformly
  across every cell in the grid.
- **Right-click** offers Save Group and Revert Group for that change's group.
- The inline **revert (↩)** reverts the change's *group*. For a group of one — the common case
  — that is exactly "revert this field"; for an entangled change it confirms first, listing the
  members, rather than firing the 409 the backend would return for a partial group revert
  (ADR-0028).
- There is **no per-plugin or per-record Save** on the panel. Bulk saving is multi-select in the
  Pending Changes tree, or Save All.

### Conflict color coding

The compare grid uses the two-axis model from
[ADR-0016](../adr/0016-two-axis-conflict-model.md). These two mappings are kept as tables
deliberately — they are enum→visual encodings that prose would only make less precise.

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

Absent fields (a null value in a non-master plugin — the PartialForm absent-field rule) render
with no background and no text color. Column headers use the worst ConflictThis across that
plugin's fields as a quick summary; individual cell colors are authoritative.

The [Plugins tree](medit-plugins-tree.md)'s record-node conflict badge is driven by the same
classification.

### VMAD (Papyrus) section

- When a record's compare response includes VMAD data, a **read-only** "Scripts (VMAD)" section
  renders below the field rows in the same table body; it is absent for record types without
  VMAD. **Editing Papyrus is out of scope** — this section never renders inputs.
- Two expandable levels: **script rows** (bold script name; per-plugin script flag; blank for
  plugins lacking the script; collapsed by default) and indented **property rows** (per-plugin
  value; hidden while the parent script is collapsed).
- Container-kind properties (array, struct, structList) are themselves collapsible with a
  summary badge when collapsed, expanding to element/member child rows; scalar and
  object/variable kinds are leaf values. A cell is **blank** when the plugin has no value for
  the property, versus an em-dash `—` when the property exists but is empty for that plugin.
  Object-kind values render as FormKey link-buttons that open the referenced record; when
  property types differ across plugins each cell appends `(TypeName)` in dimmed text.
- Conflict coloring follows the same ConflictThis rules as the field rows, driven by per-plugin
  `cellStates`. A VMAD cell can be dragged between columns to copy its value as a pending field
  change (target must be editable).

### Field type rendering rules

These apply everywhere a field value is rendered (the compare grid, pending cells, the VMAD
section, and any future surface):

1. **Never display raw integers for enums or flags** — always resolve to name(s).
2. **FormKeys render as EditorID hyperlinks** when the referenced record is indexed; fall back
   to the FormKey string otherwise.
3. **Structs and arrays are always collapsible**, default collapsed; expand state is
   per-session, not persisted across restarts.
4. **Pending values** always show the new value (not the old), on a yellow background with a
   revert button.
5. **Null / missing fields** render as an empty cell, never "null"/"undefined".
6. **Read-only cells** in immutable plugin columns are never editable and render no input on
   click.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — given a compare
  response, assert what the grid renders (rows/columns, per-cell color from `cellStates`,
  enum/flag names resolved, FormKey links, pending highlighting); given a staging interaction,
  assert the pending state and the save/revert payloads. No assertions about private component
  internals.
- **Seam**: the webview React components through their props, with the injected typed client —
  Vitest, `npm run test:unit`, no backend and no VS Code. Colocated tests per component, the
  established sibling-component pattern.
- **Record semantics and conflict classification** are the backend's responsibility and are
  tested there (`MEditService/CLAUDE.md`), not re-asserted from the webview; the frontend tests
  consume representative compare responses as fixtures.
- **Integration seam** (`npm run test:integration`, real VS Code process): navigation opens a
  record panel, and command registration holds — add any new command id(s) to
  `EXPECTED_COMMANDS`.

## Out of Scope

- **Multiple simultaneous record editor panels** — one panel is open at a time and reused when
  navigating (an extension invariant).
- **Editing Papyrus (VMAD)** — the VMAD section is read-only and never renders inputs.
- **Per-plugin and per-record save** — a ChangeGroup may span plugins, so those scopes could
  only be honoured by splitting a group. Save and revert act on a group, a multi-selection of
  groups, or everything (ADR-0029).
- **Referenced By** — a separate panel, [medit-referenced-by.md](medit-referenced-by.md).
- **Grouping semantics** — settled in ADR-0028 and computed backend-side; this surface renders
  grouping, it does not derive it.

## Further Notes

- The rationale for removing edit mode (xEdit's `toEditOnClick` parity, and the fact that
  immutability plus staging already prevent accidental writes) is recorded in #111. The
  rationale for group-scoped save/revert is
  [ADR-0029](../adr/0029-pending-changes-tree-is-a-grouping-view.md).
