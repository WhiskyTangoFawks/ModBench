# mEdit Record editor panel — Surface Specification

**Status: Implemented**, but for the Pending column's click-to-reveal, marked *planned* inline
below (#140). Two known gaps are called out where they bite: FormKey resolution (#141) and
array arity/order editing (#142).

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
5. As a user, I want a FormKey field to render as a link to the referenced record, and
   `Ctrl+click` to open that record, so that I can follow references without copying IDs
   around — the same gesture xEdit uses, leaving plain click free to edit. *(The link is
   labelled with the FormKey; labelling it with the referenced record's EditorID needs
   resolution the compare response does not carry — #141.)*
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
16. As a user, I want to inspect and edit a record's Papyrus (VMAD) script data — scripts,
    their properties, and nested array/struct/structList values — so that I can reconcile
    script conflicts in the same grid as the rest of the record.
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

- **There is no edit mode.** Editability is a property of the **column**, not of a state the
  user enters: a cell in a non-immutable column renders as text and swaps to its input **on
  click**, reverting to text on commit or blur — only the clicked cell, never the whole grid,
  since reading conflicts at a glance is the grid's primary job. This is xEdit's
  `toEditOnClick`. Immutable columns never activate an input. Dragging is always available,
  except on a cell whose own input is active (a draggable ancestor would otherwise swallow text
  selection inside the input).
- **Cells render by field schema type**: strings/numbers/bools as text/number/toggle inputs;
  enums as their name via a `<select>`; flags as active flag names via a per-flag multi-select;
  FormKeys as a link — `Ctrl+click` follows it, plain click opens a FormKey picker filtered by
  `validFormKeyTypes`, and the link affordance appears on `Ctrl`-hover only when the reference
  resolves (rule 2 below); structs and arrays as a collapsed summary expandable to child rows.
  Pending-change cells show the new value on a yellow background with a revert (↩) button.
- **Array elements edit by value, but the field grid has no arity or order controls** — no add,
  remove, or reorder. Editing an element's value restages the whole array; changing how many
  elements there are, or what order they are in, is not reachable there and never has been
  (#142). The VMAD section is the exception: it has its own element and struct add/remove.
- **Editing stages pending changes** rather than writing immediately. Copying a whole record
  into another plugin is a **column-header** action, not a panel-level one — **Copy as
  Override…** on each mutable column's header opens a picker of the other mutable plugins.
  There is no single "active editable plugin" for a panel-level control to assume. A cell value
  can also be **dragged between plugin columns** to copy it as a pending change into the target
  (which must be editable; the source need not be).

### Pending column

Per [ADR-0029](../adr/0029-pending-changes-tree-is-a-grouping-view.md) (#139). The per-plugin
Save button that once lived here called `POST /plugins/{plugin}/save`, a route the backend does
not implement and will not, so it was deleted (#136); the actions below replace it.

Every action is scoped to a **ChangeGroup**, never to part of one and never to a record or a
plugin:

- **Plain click** on a pending value reveals that change in the
  [Pending Changes tree](medit-pending-changes-tree.md). *Planned — #140.* The gesture is free
  because pending cells are not editable, and it keeps `Ctrl+click` meaning "follow the
  reference" uniformly across every cell in the grid.
- **Right-click** offers Save Group and Revert Group for that change's group. Save Group writes
  every plugin in the component and consumes its pending rows; the grid reloads to reflect what
  reached disk.
- The inline **revert (↩)** reverts the change's *group*, identically to the context menu's
  Revert Group — the confirmation keys on member count, not on which control fired it. For a
  group of one — the common case — that is exactly "revert this field" and fires straight away;
  for an entangled change both confirm first, listing the members, rather than firing the 409 the
  backend would return for a partial group revert (ADR-0028). The member count is read from
  `GET /changes` for the change's component; the panel never surfaces a raw 409.
- A **partial save** is surfaced, never silent (ADR-0026): the banner names which plugins wrote,
  partially wrote, and could not write, and states the unwritten changes stay queued. A save that
  reached disk but whose post-commit reindex failed reads instead as a completed-save warning to
  reload (#127) — honest to the severity, not "save failed".
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

- When a record's compare response includes VMAD data, a "Scripts (VMAD)" section renders below
  the field rows in the same table body; it is absent for record types without VMAD. It is
  **editable on the same terms as the field rows** — leaf cells read as text and swap to their
  editor on click, gated on the column's mutability, never on a mode. Beyond leaf values it also
  offers structural ops: add/remove script, add/remove/set-type property, script and property
  flags, and array/struct element ops.
- Two expandable levels: **script rows** (bold script name; per-plugin script flag; blank for
  plugins lacking the script; collapsed by default) and indented **property rows** (per-plugin
  value; hidden while the parent script is collapsed).
- Container-kind properties (array, struct, structList) are themselves collapsible with a
  summary badge when collapsed, expanding to element/member child rows; scalar and
  object/variable kinds are leaf values. A cell is **blank** when the plugin has no value for
  the property, versus an em-dash `—` when the property exists but is empty for that plugin.
  Object-kind values render as FormKey link-buttons, following the same `Ctrl+click` gesture as
  every other link in the grid; when property types differ across plugins each cell appends
  `(TypeName)` in dimmed text.
- Conflict coloring follows the same ConflictThis rules as the field rows, driven by per-plugin
  `cellStates`. A VMAD cell can be dragged between columns to copy its value as a pending field
  change (target must be editable).

### Field type rendering rules

These apply everywhere a field value is rendered (the compare grid, pending cells, the VMAD
section, and any future surface):

1. **Never display raw integers for enums or flags** — always resolve to name(s).
2. **FormKeys render as links**, labelled with the FormKey string. The **link affordance**
   (underline, pointer) appears only while `Ctrl` is held and the pointer is over the cell, and
   only when the reference resolves; `Ctrl+click` follows it, and a link that does not look
   followable is not followable. This mirrors xEdit's `vstViewCheckHotTrack`, which gates
   hot-tracking on `Allow := Assigned(lLinksTo)` — a link you cannot follow must not look like
   one.

   *The resolve test is currently a proxy, and a known-limited one (#141).* The frontend has no
   per-FormKey resolution: the compare response carries the FormKey string and nothing about
   what it points at. So in the **field grid** the affordance keys off the field's
   `checkError`, which the backend emits (`<Error: Could not be resolved>`) exactly when a
   FormLink is absent from the record index. What ships therefore tracks **"this cell is not
   flagged suspect"**, not **"this reference is genuinely indexed"**. Two deliberate
   divergences follow, both erring toward hiding a real link rather than advertising a dead
   one, and both landing on cells that already show a ⚠:
   - a reference that resolves but to the **wrong type** carries a `checkError`, so the
     affordance is suppressed though xEdit would allow the jump;
   - for a **struct or array leaf**, `checkError` is the parent field's aggregate, so one
     dangling member suppresses the affordance on its siblings.

   In the **VMAD section** the proxy is weaker still, and errs the other way: a
   `VmadPropertyDiff` carries no `checkError`, so the only available test is that the Object
   property's FormKey is well-formed — which catches an unset reference (`Null [-1]`) but not
   one pointing outside the index, leaving that case looking followable.

   #141 removes the proxy on both surfaces by carrying resolution in the compare response,
   which is also what rule 2 needs to label links with the referenced record's EditorID rather
   than its FormKey.
3. **Structs and arrays are always collapsible**, default collapsed; expand state is
   per-session, not persisted across restarts. Array **element values** are editable
   everywhere. Array **arity and order** divide by surface, so this rule does not generalize:
   the VMAD section has add/remove element and add/remove struct, while the **field grid has
   none** — no add, no remove, no reorder (#142).
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
- **Editing Papyrus source** — the VMAD section edits script *data* (properties, their values
  and types, script and property flags). Compiling or editing `.psc` source is a different job
  and is not this surface's.
- **Per-plugin and per-record save** — a ChangeGroup may span plugins, so those scopes could
  only be honoured by splitting a group. Save and revert act on a group, a multi-selection of
  groups, or everything (ADR-0029).
- **Referenced By** — a separate panel, [medit-referenced-by.md](medit-referenced-by.md).
- **Grouping semantics** — settled in ADR-0028 and computed backend-side; this surface renders
  grouping, it does not derive it.
- **Array arity and order editing *in the field grid*** — no add, remove, or reorder; tracked
  as #142, which has to settle how an arity change stages under ADR-0017's
  `old_value`/`new_value` model and how sorted (`wbArrayS`) and unsorted (`wbArray`) arrays
  differ. Not a limit of the VMAD section, which has its own.

## Further Notes

- The rationale for removing edit mode (xEdit's `toEditOnClick` parity, and the fact that
  immutability plus staging already prevent accidental writes) is recorded in #111. The
  rationale for group-scoped save/revert is
  [ADR-0029](../adr/0029-pending-changes-tree-is-a-grouping-view.md).
- #111 also established that editability is per **column**, replacing a mode: before it, the
  cells were never told which columns were immutable, so a read-only column rendered inputs
  whose stage the backend then rejected with a 409.
