# mEdit Record editor panel — Surface Specification

**Status: Implemented, but the interaction model below is newly specified and NOT yet built.**
The grid, conflict colouring, type-appropriate editors, pending changes, drag-to-copy and the
column-header menu all ship and work. What does not yet match this document is the **gesture
model**: [ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md) replaced
ADR-0033 after [an audit of xEdit](../research/xedit-ux-audit.md) showed mEdit had specified
single-click-to-edit, which xEdit does not do. Today a single click still activates an editor,
there is no cell focus, no keyboard, and no clipboard commands; cells still show a `grab` cursor
and immutable cells still activate a read-only surface. Everything in *Interaction model* below
describes the target, not the build. Known gaps beyond that: VMAD is architecturally outside the
shared cell entirely (#219) and FormKey resolution (#141).

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
   around — the same gesture xEdit uses. *(The link is
   labelled with the FormKey; labelling it with the referenced record's EditorID needs
   resolution the compare response does not carry — #141.)*
6. As a user, I want structs and arrays shown collapsed with a summary and expandable to their
   sub-fields/elements, so that a complex record stays readable.
7. As a user, I want to focus a field with a click and open its editor the way xEdit does — a
   second click, `F2`, or a double click — getting the right input for its type (text, number,
   toggle, dropdown, flag multi-select, FormKey picker), so that editing is type-appropriate, I
   can't enter a nonsensical value, there is no mode to enter first, and only one cell is ever an
   input so the grid stays readable.
8. As a user, I want my edits shown as pending changes (highlighted, revertable via right-click)
   rather than written immediately, so that I can review a batch before committing and back out
   an edit I regret.
9. As a user, I want a pending column to appear for a plugin with staged changes, so that I can
   compare my in-progress edit against every existing version.
10. As a user, I want to collapse a plugin column to just its header chip, with the state
    remembered, so that I can focus the grid on the plugins I care about.
11. As a user, I want a column-header menu to copy a plugin's whole record into my editable
    plugin as pending changes, copy it as a new record, or stage removal of that plugin's
    override, so that common override operations are one action.
12. As a user, I want to drag a value — scalar or whole compound field alike — from one plugin's
    column into another to copy it as a pending change, so that reconciling a conflict is direct
    manipulation.
13. As a user, I want to click any cell — including one in a read-only plugin — and press `Ctrl+C`
    to put its value on the clipboard, so that I can lift a value out of the grid to use in a
    script, a patch, or another tool without retyping it. Copy takes the cell's value, not
    whatever text I could select, so it works the same on a flag list, a dropdown and a reference
    as it does on a string.
13. As a user, I want to save or revert a pending value from here — acting on that change's
    whole ChangeGroup, never on part of one — or copy a specific plugin's version of the whole
    record into another plugin, so that I control exactly what gets written and where without
    leaving the record I am working on.
14. As a user, I want to right-click a pending value to reveal that change in the Pending Changes
    tree, so that I can get from "what did I change here" to "what else does this drag along"
    without hunting — while it stays directly editable, on the same terms as any other cell.
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

### Interaction model

**xEdit's model, ported** — the compare grid, VMAD and Condition sections alike
([ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md), which supersedes
ADR-0033; the behaviour being matched is catalogued in
[the xEdit UX audit](../research/xedit-ux-audit.md)). Every user of this panel arrives fluent in
xEdit, so it is the reference, and divergence needs a platform limitation to justify it — not a
better idea.

- **Left-click** — **focus this cell.** The row highlights; one cell within it carries focus. That
  is all a single click does: never edit, never navigate, never reveal, never a menu. Selection is
  single-cell, single-row — no ranges. The focused cell is what the keyboard then acts on, which is
  the whole reason click is spent on focus rather than on editing.
- **Left-click on the already-focused cell** — open its inline editor. The Explorer
  "click, then click again to rename" pattern, and xEdit's `toEditOnClick`.
- **Double-click a value cell** — open the fullest editor that type has: the inline editor for
  numeric and flag types, the extended editor for text and references. **Double-click the label
  column** — expand/collapse that node.
- **The keyboard acts on the focused cell** — `F2` edit · `Ctrl+C` copy · `Ctrl+X` cut ·
  `Ctrl+V` paste · `Insert` add a list entry · `Delete` remove the entry or clear the value ·
  `Ctrl+↑`/`Ctrl+↓` reorder within an unsorted list. **Clipboard operations carry the cell's model
  value, not selected text**, so they work identically whether the cell renders a text box, a
  dropdown, a checkbox or a link, and in both column kinds. Copy needs no text surface and no
  selection, which is why neither exists here.
- **Click-and-hold, drag, drop** — copy this value's content directly into wherever it's dropped.
  Available from any cell regardless of the *source* column's mutability (only the drop target's
  mutability gates the drop); applies to compound (struct/array) fields via their header/summary
  row exactly as it applies to a scalar leaf's value. **The cursor does not advertise it** — a
  resting cell shows the default arrow, as in xEdit. `grab` on every value cell was ADR-0033's
  attempt to make one cursor state two gestures at once; with click meaning focus there is nothing
  for the cursor to disambiguate.
- **Right-click** — the only place a named, discrete action lives. On a **value cell** that is the
  list structure ops (**Add** / **Remove** / **Clear** / **Move Up** / **Move Down**), which are
  also the `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓` accelerators above — the menu is the canonical
  definition and the keys are shortcuts onto it, exactly as in xEdit, and there are **no inline
  ▲▼✕ controls**, per the no-second-route rule below. On a pending cell:
  **Reveal in Pending Changes Tree** / **Save Group** / **Revert Group**,
  **Copy All to Pending** / **Copy as New Record** / **Copy as Override…** / **Remove** / **Add
  Master…** on a column header (the last only on the header record's own column, and only when
  mutable — ADR-0033: no standalone control once an action is right-click-reachable, same rule
  #207 applied to the inline revert button). An action reachable through right-click is never also
  reachable a second way (no standalone revert icon once Revert Group exists; no standalone Add
  Master… button once its menu entry exists). Both the pending-cell menu (#208) and the
  column-header menu (#209) are VS Code's own native context menu
  (`contributes.menus["webview/context"]`, gated on a `data-vscode-context` attribute the cell/
  header carries — [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md)'s
  native-first precedent applied inside the webview) rather than a rendered overlay. Column-header actions that need
  a target plugin (all but Remove) open a `showQuickPick` listing the mutable plugins minus the
  right-clicked column, with a "New Plugin…" entry — the same QuickPick `modbench.copyAsOverrideInto`
  already opens from the plugins tree, extended to accept the column header's record identity
  too, rather than a second picker implementation; filterable and keyboard-first, but no longer
  positioned at the click like the retired in-webview list. Add Master…'s own QuickPick lists
  every loaded plugin minus the header record's own plugin minus whatever's already a master —
  deliberately not filtered to mutable plugins (a master is very often an immutable base-game/DLC
  esm) — and has no "New Plugin…" entry.
- **Ctrl+click** — acknowledged for now as a fourth, navigation-only gesture (follows a FormKey
  reference to its record). Whether it survives once a right-click "Go to Record" exists is still
  undecided — see Further Notes.

No cell shows an affordance for an action it cannot perform. With click meaning focus, that is a
much smaller claim than it was under ADR-0033: the cursor is the default arrow everywhere, drag is
unadvertised (as in xEdit), and the only resting affordance is the Ctrl-hover link underline on a
reference that actually resolves.

### Gesture matrix

Where each gesture is available. Under
[ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md) this is nearly uniform,
which is the point — the previous model's availability holes were consequences of routing copy
through DOM text selection, and they close when the clipboard carries the model value instead.

#### Uniform across every value cell, both column kinds

Focus on click · drag out · `Ctrl+C` copy · right-click menu · default arrow cursor.
Drop in and all mutating operations (`Ctrl+V`, `Ctrl+X`, `F2`, `Insert`, `Delete`, `Ctrl+↑`/`↓`,
editing of any kind) are **mutable columns only** — an immutable cell simply refuses, showing no
distinct affordance beforehand, exactly as xEdit does.

#### By cell

| Cell | Second click / `F2` opens | Double-click opens |
| --- | --- | --- |
| `string` | text editor | extended editor |
| `int`, `float` | number editor | number editor (inline — matches xEdit's `dtInteger`/`dtFloat`) |
| `bool` | checkbox | checkbox |
| `enum` | dropdown | dropdown |
| `flags` | multi-select checklist | multi-select checklist (xEdit's `dtFlag` is inline) |
| `formKey` | native QuickPick | native QuickPick |
| empty (`—`) | the type's editor (mutable only) | as second click |
| struct / array summary | nothing | expand/collapse |
| label column | — | expand/collapse |

The only cells that open *nothing* are struct and array summary rows, which render a placeholder
(`{…}`, `[3]`) rather than a value. They remain focusable, copyable and draggable — dragging one
copies the whole structure, as xEdit does when you drag by the header.

#### Why copy is uniform now

`Ctrl+C` copies the focused cell's **model value**, the same string its editor would show — xEdit's
`Element.EditValue`. It never reads DOM text and never needs a selection, so it does not care which
widget the cell renders. That removes the old model's two holes at once: `bool`/`enum`/`flags` on a
mutable column had no copy path because their editor was a control rather than text, which produced
the inversion where a read-only column could hand over its value and an editable one could not.
Neither survives.

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
  left-click collapses/expands a column (state persisted in session); right-click opens VS Code's
  own native menu offering **Copy All to Pending** (every field from the right-clicked column into
  a picked target plugin) / **Copy as New Record** (same values, a fresh FormKey in the target) /
  **Copy as Override…** (copies the *currently-loaded* record — not necessarily the right-clicked
  column's own version — into a picked target plugin; the same `modbench.copyAsOverrideInto`
  command the plugins tree uses) / **Remove**, absent rather than merely disabled for an immutable
  column / **Add Master…** (header record's own column only, mutable only). The grid's scroll
  region is bound to the
  panel's viewport, not to its own content height, so a horizontal scrollbar (for wide grids with
  many plugin columns) stays reachable at the bottom of the visible viewport regardless of
  vertical scroll position, instead of only appearing at the bottom of a possibly very tall table
  (#175).

### Editing

- **There is no edit mode.** Editability is a property of the **column**, not of a state the user
  enters. A cell renders as text and swaps to its input when *opened* — by a second click on the
  already-focused cell, by `F2`, or by a double click — reverting to text on commit or blur. Only
  the opened cell is ever an input, never the whole grid, since reading conflicts at a glance is
  the grid's primary job. This is xEdit's `toEditOnClick`, which means "a click on the focused
  cell", not "any click".
  An **immutable** column simply refuses: no editor opens, and **no distinct affordance says so
  beforehand** — matching xEdit, whose `vstViewEditing` sets `Allowed := False` and shows nothing
  in advance. There is no read-only surface, because there is nothing for it to do: `Ctrl+C` on a
  focused cell copies its value without needing anything selectable on screen.
  The editor **selects its whole text on focus**, so `Ctrl+V` replaces rather than appends and
  typing replaces.
  Dragging (copy this value into another column) is available on **every** cell regardless of that
  cell's own editability — only the *drop target's* mutability gates the drop — and is suppressed
  while that cell's own input is open.
  **A cell rendering a placeholder opens nothing**: struct and array summary rows (`{…}`, `[3]`)
  and an empty cell (`—`) on an immutable column. They remain focusable, copyable and draggable —
  dragging a summary copies the whole structure. A **mutable** empty cell does open its editor, or
  the field could never be given a value in the first place.
- **Cells render by field schema type**: strings/numbers/bools as text/number/toggle inputs;
  enums as their name via a `<select>`; flags as active flag names via a per-flag multi-select;
  FormKeys as a link — `Ctrl+click` follows it, and opening the cell on a mutable column (second
  click / `F2` / double click) opens a native
  **QuickPick** (#210; the webview cannot call `vscode.window.createQuickPick` itself, so this
  round-trips through the extension host), seeded with the current reference — as the same
  `EditorID [FormKey]` composite the cell displays and the picker's own items use (#218), not the
  bare FormKey, so the input does not contradict the list beneath it — and filtered by
  `validFormKeyTypes`. The seed goes through the same normalization a pasted composite does, so it
  costs the search nothing. Typing searches records as you type (200ms debounce), matching EditorID or
  — since #210 — a FormKey-shaped query directly, with the same "EditorID [FormKey]" item labels
  the picker always used; Escape leaves the field unchanged. **This QuickPick is also the paste
  target for a FormKey cell** — it is a native input, so `Ctrl+V` into it needs nothing built. A
  query carrying a bracketed segment (i.e. a whole `EditorID [FormKey]` label pasted from a cell or
  from another picker item) is normalized to the bracket's contents before searching; if the label
  and the FormKey disagree — a stale copy, a hand-edited string — **the FormKey wins**, since it is
  the identity. A query with no bracket is searched as typed, so bare FormKeys and bare EditorIDs
  behave exactly as they do today. Autocomplete is what makes paste safe here: a pasted reference
  is not committed until it has resolved to a real record in the list. "Seeded ... and pre-selected" means
  the matching record is the active/highlighted item in the QuickPick's results list — VS Code's
  `QuickPick` has no `InputBox`-style `valueSelection`, so the seeded *text* itself is visible but
  not selectable the way an `<input>`'s select-on-focus would be; `Ctrl+A` clears it to search
  fresh. **A consequence, and the one asymmetry left in the cursor contract:** a *mutable* FormKey
  cell has no read-only surface — plain click is spent on the picker — so if the QuickPick's input
  cannot be selected and copied, that cell cannot hand over its own displayed value the way every
  other cell can. Seeding with the composite makes the reference at least fully *visible* there;
  whether it is also copyable is unverified (#218). The same picker backs the VMAD add-property dialog's Object-typed value and the VMAD
  table's Object-property cells. The link affordance appears on `Ctrl`-hover only when the
  reference resolves (rule 2 below); structs and arrays as a collapsed summary expandable to child rows,
  and are themselves drag sources for their whole value via that summary row, the same as a
  scalar leaf, collapsed or expanded alike (#204). Pending-change cells show the new value on a
  yellow background and are directly editable on the same terms as disk cells (see Pending
  column for how they're reverted).
- **Unsorted array fields have arity and order operations** — **Move Up** / **Move Down** (swap
  with the neighbour) and **Remove** on an element row, and **Add** on the parent array row,
  appending a default-valued element (#142). They live in the **right-click menu**, with
  `Ctrl+↑` / `Ctrl+↓` / `Delete` / `Insert` as accelerators onto the same menu items — xEdit's
  arrangement exactly, and required by the no-second-route rule: **there are no inline ▲▼✕
  buttons.** (They shipped as inline buttons in #142, before ADR-0034; converting them is part of
  adopting the model.) Sorted (`wbArrayS`) arrays offer none of these — order is derived from the
  sort key, so the entries are absent, not merely disabled. All three ops restage the **whole
  array** as a single field edit (same path as an element-value edit; ADR-0017), and only on
  non-immutable columns. There is no free drag-reorder and no auto-sort. The VMAD section keeps
  its own separate element/struct add/remove.
- **Editing stages pending changes** rather than writing immediately. Copying a whole record
  into another plugin is a **column-header** action, not a panel-level one — **Copy as
  Override** on a column's header opens a picker of the other mutable plugins and copies *that
  column's* version of the record (not necessarily the overall winner) into the one picked.
  There is no single "active editable plugin" for a panel-level control to assume. A single
  field's value can instead be **dragged between plugin columns** to copy just that field as a
  pending change into the target (which must be editable; the source need not be) — or **copied
  and pasted** when the target isn't conveniently reachable by drag, or lives outside mEdit
  entirely: click the source cell, `Ctrl+C`, click the target, `Ctrl+V`. **Copy works on every
  cell of every type in both column kinds**, and paste on every cell of a mutable column, because
  the clipboard carries the cell's model value rather than selected text — there is no widget for
  it to be incompatible with. This is what `Ctrl+C`/`Ctrl+X`/`Ctrl+V` do in xEdit
  (`Element.EditValue`), and adopting it removes the previous model's two availability holes:
  `bool`/`enum`/`flags` having no copy path on a mutable column, and the resulting inversion where
  a read-only column could hand over its value and an editable one could not.

### Pending column

Per [ADR-0029](../adr/0029-pending-changes-tree-is-a-grouping-view.md) (#139). The per-plugin
Save button that once lived here called `POST /plugins/{plugin}/save`, a route the backend does
not implement and will not, so it was deleted (#136); the actions below replace it.

Every action is scoped to a **ChangeGroup**, never to part of one and never to a record or a
plugin:

- **Plain click** on a pending value edits it directly, on the same terms as a disk cell
  ([ADR-0033](../adr/0033-one-gesture-one-meaning-in-the-record-editor.md), #203) — there is no
  lock on the corresponding disk cell in response; both stay editable simultaneously for now
  (revisit later if that proves confusing in practice). This holds in the main field grid, the
  VMAD section, and the Condition section alike — three independent render paths, one rule.
- **Right-click** on a pending value opens VS Code's own native context menu (#208 —
  `contributes.menus["webview/context"]`, gated by a `data-vscode-context` attribute the cell
  carries; the cell must not call `preventDefault()` on the contextmenu event, or VS Code's
  webview preload suppresses its own menu) offering **Reveal in Pending Changes Tree** (selects
  its node in the [Pending Changes tree](medit-pending-changes-tree.md), expanding the parent
  group for a multi-member change; a change already saved or reverted resolves to nothing and is
  logged, not thrown), **Save Group** (writes every plugin in the component and consumes its
  pending rows; the grid reloads to reflect what reached disk), and **Revert Group** — the
  group's only three actions, all in one menu, and the only way to trigger any of them
  ([ADR-0033](../adr/0033-one-gesture-one-meaning-in-the-record-editor.md): no standalone revert
  icon on the cell now that Revert Group lives in the menu). VS Code's built-in Cut/Copy/Paste
  entries are suppressed on this menu (`preventDefaultContextMenuItems`), which costs nothing: a
  pending value is directly editable (#203), so its text is reached by clicking it — the same
  cursor contract every other cell follows — not from a menu. Reveal resolves entirely in the extension host (no webview
  round trip); Save Group and Revert Group's work (the HTTP calls, the confirmation below, the
  partial-save/stale-reindex banner) only exists in the webview, so the command broadcasts to
  every open record panel and each one silently ignores a change id it doesn't hold — a change id
  is never shared across two different records, so at most one panel ever acts. Revert's
  confirmation keys on member count, not on which control fired it: a group of one — the common
  case — is exactly "revert this field" and fires straight away; an entangled change confirms
  first, via a **native modal warning** (#212 — `vscode.window.showWarningMessage(..., { modal:
  true })`, reached through the same webview↔extension-host bridge shape as the FormKey/
  condition-function QuickPicks: the webview posts the already-composed detail text — one line
  per linked edit, `recordType / formKey · fieldPath` — and awaits the extension host's reply,
  since showWarningMessage is extension-host-only), rather than firing the 409 the backend would
  return for a partial group revert (ADR-0028). The member count is read from `GET /changes` for
  the change's component; the panel never surfaces a raw 409.
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
- **Add script** is a **native input box** (#212 — `vscode.window.showInputBox`, same
  webview↔extension-host bridge shape as the modal warning above) collecting the one field it
  needs, a name; an empty/whitespace name is rejected by the box's own `validateInput` before it
  can be accepted. A new script always starts with `Local` flags — there is no flags field at
  creation any more, only the per-script flags control afterward. **Add property** stays a
  webview-rendered dialog (`ModalShell`/`AddPropertyDialog`) — the one deliberate exception, since
  it collects three fields (name, type, value) at once and a multi-step QuickPick chain would be
  worse UX than the dialog it would replace (see the comment on `ModalShell` for why this one
  wasn't converted).
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

### Condition (CTDA) section

- When a record's compare response includes condition data, one section per condition-owning
  field renders below the field rows in the same table body — a record with more than one
  condition-carrying field (e.g. a Quest's `DialogConditions` and `UnusedConditions`) gets one
  labeled section per field, each with its own header naming that field, one row per condition,
  one column per plugin; the whole thing is absent for record types that carry no condition
  fields at all (#154). It reuses the grid's `Column`/`cellStates` conflict coloring rather than a
  separate modal or panel (ADR-0032).
- A condition-owning field renders **only** in its Condition section, never also as a raw generic
  field row above — `SchemaReflector` excludes any property `IConditionCodec.IsConditionListField`
  recognizes from the generic reflection pass, the same way it already excludes `FormKey`/`EditorID`/
  other structural fields (#178).
- Each row renders a human-readable summary — function name, its typed parameters, the Run On
  target, comparison operator, and comparison value — instead of raw struct fields.
- The section is **editable on the same terms as the field rows and the VMAD section**: leaf
  fields (function, each parameter, Run On, operator, comparison value, and the Use-Global
  toggle) stage through the ordinary pending-change `onEdit` path, gated on the column's
  mutability, never on a mode. A parameter's input type (FormKey picker / number / string) is
  resolved per-function from Mutagen's typed getters, and switching a condition's function
  reshapes its parameter inputs to the new function's parameter signature — the backend resets
  the condition's parameter storage to the new shape at write time
  (`Fallout4ConditionCodec.ApplyFieldValue`), so no parameter value from a different function's
  shape can silently persist in the wrong type. Toggling Use-Global swaps the comparison-value
  input between a plain number and a GLOB-record FormKey picker.
- The function picker is a native **QuickPick** (#211; same round-trip through the extension host
  as the FormKey QuickPick above, since the webview cannot call `vscode.window.showQuickPick`
  itself) listing the function catalogue backed by `GET /condition-functions`, filtered
  server-side to the functions Mutagen actually resolves for the record's game/category — never a
  hardcoded, unfiltered enum dump. Unlike the FormKey QuickPick, the catalogue is small and
  game-scoped, so it's fetched once (not per keystroke) and handed to a plain `showQuickPick` —
  filter-as-you-type is VS Code's own built-in list filtering, not a hand-rolled search. "Seeded
  with the current value" means the current function is sorted to the front of the item array —
  `showQuickPick` has no `activeItem` option the way `QuickPick` does, so array order is the only
  way to pre-highlight an item; VS Code focuses the first item by default. Escape/blur leaves the
  condition's function unchanged.
- The AND/OR flag between conditions renders read-only.
- Each condition-owning field is keyed and staged independently by its own field name (backend:
  `ConditionOwner.FieldPath`/`ConditionGroupDiff.FieldPath`, discovered by
  `Fallout4ConditionCodec.Extract` reflecting over every top-level property shaped like a
  condition list, not a single hardcoded name; frontend: each `ConditionSection` group edits and
  restages at its own `group.fieldPath`) — editing, adding, removing, or reordering one field's
  list never collides with a sibling condition-carrying field on the same record (#154).
- Condition lists nested one array level below the record (e.g. a magic Effect's own
  `Effects[i].Conditions` on Ingestible/Ingredient/Spell/ObjectEffect, a Message's
  `MenuButtons[i].Conditions`) are discovered by the same shape test applied to each array element,
  keyed by an indexed field path composing the enclosing array's own name and index with the
  nested list's own name (e.g. `Effects[2].Conditions`) — the existing
  `CTDA\<field path>\<index>\<subField>` wire path treats that whole composed string as one opaque
  field path, so no DDL or wire-shape change was needed (#181). A path through a **Child record** (a
  record type Mutagen enumerates as its own top-level row, e.g. Quest's `Scenes`/`DialogTopics`) is
  excluded, since that record already surfaces its own conditions through its own top-level field.
  Nested groups align across plugins positionally by the enclosing array's index (the glossary's
  Unsorted array rule, ADR-0019) and sort by that index numerically, not lexicographically. In the
  grid, a nested group renders collapsed by default — only its header shows until clicked — while a
  flat top-level group is unaffected and keeps rendering fully open. Read-only for now, on both
  ends: the frontend renders a nested group's rows display-only (no function/parameter/operator
  inputs, no add/move/remove controls) rather than an editable control that would only fail later,
  and `PluginWriter.IsReadOnly` rejects a nested (indexed) condition path at stage time as a second,
  independent gate. Staging an edit at a nested path stays rejected until scalar editing lands
  (#182), add/remove/reorder inside a nested list until #183, and two levels of nesting (a Perk
  effect's own conditions, a Quest alias's/stage's own conditions) until #184.
- **Add/remove/reorder** controls (Add, Move-up, Move-down, Remove) render per condition row,
  gated by the same immutable-column rule as every other edit. Unlike VMAD's structural ops
  (which dispatch a named op the backend applies), a condition list has no stable per-element
  identity (ADR-0019 — array indices have no stable identity), so arity/order changes are
  computed entirely client-side (`conditionOps.ts`) and staged as one plain `FieldEdit` at the
  list's own owning field path (e.g. `"Conditions"`, or `"DialogConditions"`/`"UnusedConditions"`
  on a record with more than one condition-carrying field) — the same whole-subtree-restage
  pattern VMAD's plain arrays already use. Before applying an op, the current list is folded with
  the plugin's own outstanding per-field pending edits so an in-flight edit is never silently
  dropped; staging the restage then supersedes (clears) those now-stale per-field pending rows,
  and a save applies the whole-list restage before any of that plugin's sibling per-field edits,
  so adding a condition and immediately editing one of its fields in the same session writes back
  correctly.
- Codec support is FO4-only today, reflecting Mutagen's four structurally different per-game
  condition data shapes (no shared cross-game interface, unlike VMAD's `IHaveVirtualMachineAdapter`)
  — a per-game `IConditionCodec` strategy resolved by `GameCategory` (ADR-0032); other games are
  tracked separately (#164).
- FormKey-typed condition parameters and the Run On reference inherit the same
  resolution-signal gap as VMAD (#141/#166) until that lands — they render the raw FormKey.

### Field type rendering rules

These apply everywhere a field value is rendered (the compare grid, pending cells, the VMAD
section, and any future surface):

1. **Never display raw integers for enums or flags** — always resolve to name(s).
2. **FormKeys render as links**, labelled `EditorID [FormKey]` when the reference resolves and the
   bare FormKey when it doesn't — the same composite the picker's own items have always used, so
   the format a reference is *chosen* in and the format it is *read back* in are identical.
   Labelling with the EditorID alone (as #157 shipped) is superseded: a FormKey is the identity and
   the EditorID is decoration, and a cell that does not display its own identity cannot hand it to
   the user by any mechanism — which under ADR-0033's cursor contract is the whole of copy. Where
   the composite is too wide for its column it is truncated with an ellipsis, which does not
   truncate what a selection copies. The **link
   affordance** (underline, pointer) appears only while `Ctrl` is held and the pointer is over
   the cell, and only when the reference resolves (valid type *or* wrong type — xEdit allows
   following either); `Ctrl+click` follows it, and a link that does not look followable is not
   followable. This mirrors xEdit's `vstViewCheckHotTrack`, which gates hot-tracking on
   `Allow := Assigned(lLinksTo)` — a link you cannot follow must not look like one.

   The **field grid** (ADR-0031, #157) sources both the label and the affordance from the
   backend's per-FormKey resolution signal on `FieldDiff` — a tri-state (unresolved /
   resolved-wrong-type / resolved-valid-type) computed server-side against the global FormKey
   index, carried independently per leaf so a dangling struct/array member never suppresses the
   affordance on the leaf next to it. `checkError` still drives the ⚠ icon but no longer gates
   the link.

   The **VMAD section** sources the same signal from `VmadPropertyDiff.resolutions` (#158) —
   an Object-kind property's link label and affordance follow the real resolution, not a
   well-formedness proxy, so a dangling reference (one pointing outside the index) no longer
   looks followable.
3. **Structs and arrays are always collapsible**, default collapsed; expand state is
   per-session, not persisted across restarts. Array **element values** are editable
   everywhere. Array **arity and order** are editable in the field grid for **unsorted** arrays
   (add / remove / move-up / move-down, swap-based, on non-immutable columns) and **absent** for
   sorted (`wbArrayS`) arrays, whose order is sort-key-derived (#142). The VMAD section keeps its
   own add/remove element and add/remove struct.
4. **Pending values** always show the new value (not the old), on a yellow background; revert is
   menu-only (right-click **Revert Group**, see Pending column), not a cell-level control.
5. **Null / missing fields** render as an empty cell, never "null"/"undefined".
6. **Read-only cells** in immutable plugin columns are never editable and render no input on
   click.

### Action logging

Editor interactions emit a leveled line on the **Modbench** output channel (#198), so the
channel's native level filter controls volume. The webview has no channel of its own: it posts a
`LOG` message over the existing webview→extension-host bridge and the router dispatches it to the
channel at the carried level (#200).

- **DEBUG** — the field-edit family: a committed disk-cell edit, a VMAD or Condition leaf edit, a
  successful drag-copy between plugin columns, and array add / remove / move-up / move-down. These
  are high-frequency and fine-grained.
- **INFO** — discrete persist/discard operations: Save Group and Revert Group on a pending cell,
  and the column-header Copy as New Record and Remove.
- **WARN** — the system correctly refusing something: dropping a dragged value onto an immutable
  target column, which stages nothing.

Lines carry **identity only** — plugin, field path, and record FormKey — never the field's old or
new value, so a large array or struct edit can't flood the panel.

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
- **Array arity/order editing of *sorted* (`wbArrayS`) arrays** — deliberately absent: order is
  derived from the sort key, so add/remove/reorder controls do not render on them. Unsorted
  (`wbArray`) arrays gained field-grid arity/order controls in #142 (arity changes restage the
  whole array under ADR-0017's `old_value`/`new_value` model).

## Further Notes

- The rationale for removing edit mode (xEdit's `toEditOnClick` parity, and the fact that
  immutability plus staging already prevent accidental writes) is recorded in #111. The
  rationale for group-scoped save/revert is
  [ADR-0029](../adr/0029-pending-changes-tree-is-a-grouping-view.md).
- #111 also established that editability is per **column**, replacing a mode: before it, the
  cells were never told which columns were immutable, so a read-only column rendered inputs
  whose stage the backend then rejected with a 409.
- **Open question: does `Ctrl+click`-to-follow survive alongside a right-click "Go to Record"?**
  [ADR-0033](../adr/0033-one-gesture-one-meaning-in-the-record-editor.md) acknowledges `Ctrl+click`
  as a fourth gesture for now without resolving this. The tension: it's undiscoverable (no visible
  UI element hints at it) but is also shipped, xEdit-familiar muscle memory: removing it costs
  existing users a gesture they already rely on; keeping it alongside a menu item means two ways
  to do the same thing, the exact redundancy this ADR otherwise rules out everywhere else in this
  surface. Unresolved until decided explicitly.
