# mEdit Record editor panel — Surface Specification

**Status: Implemented.** Editing is git-native (ADR-0041): a field edit writes the record's
working-tree source text directly — there is no staged intermediate state and no second
column standing in for one. The grid, conflict colouring, and type-appropriate editors below all
ship and work on that write path. Review, commit, and revert happen in VS Code's native Source
Control panel, one repo per tracked mod — see
[Version control — Track, branch, compile](medit-version-control.md) for that surface; this
document covers the grid and its gestures only.
The **gesture model** is [ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md),
catalogued in [the xEdit UX audit](../research/xedit-ux-audit.md).
In the field grid, a single click focuses
the cell — the row highlights, the focused cell is outlined, focus survives a re-render, and no
cell shows a `grab` cursor. Editing is off single click: a second click on the focused
cell, `F2`, or a double click opens a mutable cell's editor; double-clicking the label column
expands/collapses that node; the editor selects its whole text on focus. Every scalar type,
`string` included, agrees on this: second click, `F2` and double click all open the same inline
editor, immediately, with no debounce ([ADR-0039](../adr/0039-no-left-click-leaves-the-record-panel.md)
— no left-click gesture may relocate the user out of the record panel). `Ctrl+C` copies
the focused cell's model value in both column kinds; `Ctrl+X`/`Ctrl+V` are the mutating half
of that same contract — clipboard read/write both round-trip through the extension host, and both
commit through the ordinary onEdit path, coercing the pasted string the same way the typed-editor
path does. A pasted reference into a FormKey cell still goes through its QuickPick editor,
not a closed-cell paste of its own — see the FormKey paste note below. Unsorted-array arity/order
ops (Add/Remove/Move Up/Move Down) live on the right-click
menu with `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓` as accelerators; there are no inline ▲▼✕/＋
buttons. There is no read-only value
surface: an immutable cell opens nothing on plain click, second click, `F2`, or double click —
**a `string` cell included** (ADR-0039) — with Ctrl+C on the focused cell as every
immutable cell's copy path regardless, and the right-click menu's **Open in Editor…** entry (see
*Editing* below) as a long immutable value's own read path, read-only. VMAD and Conditions render as ordinary rows in this same
tree and inherit its focus model in full (see *VMAD and Conditions are ordinary rows in the
one tree* below for the handful of still-open, explicitly scoped gaps).

Editing context — operates on **records**, **FormKeys**, and **plugins**;
the Mod-Management vocabulary ("mod", "loadout", "deploy") belongs to the sibling surfaces, not
here ([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

One of the mEdit view's surfaces — see [medit.md](medit.md) for the shared load order lifecycle,
status bar, command palette, and architecture seams. Siblings:
[Plugins tree](plugins.md) (what opens this panel),
[Referenced By tree](medit-referenced-by.md),
[Version control](medit-version-control.md) (where edits are reviewed and committed).

## Problem Statement

Conflicts between plugins are the crux of patching. For a given record and field a mod author
needs to know which plugin wins, which lost an override, whether an apparent conflict is a real
disagreement or an identical duplicate — and then make a targeted edit that lands cleanly and
writes back to the right physical file. Answering that by opening plugins one at a time and
diffing by eye does not scale past a couple of overrides, and the values themselves resist
reading: enums and flags are integers, FormKeys are opaque, structs and arrays nest.

The edit itself is dangerous in a way a text editor's is not. A record is referenced by other
records, lives in a file that may be read-only, and may be entangled with edits elsewhere in
the load order. An editor that writes on keystroke, or that hides which plugin a value will land
in, produces broken plugins.

## Solution

> **Current behaviour (#618): the grid renders exactly one column — the winning override.**
> The multi-column description throughout this document is the **designed** shape, not the shipped
> one. On a maintainer ruling, the override-stack columns were removed pending a proper UX design
> pass; [ADR-0019](../adr/0019-xedit-unified-tree-model-for-compare-grid.md) and
> [ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md) stand and remain the
> reference for that work. Nothing structural was removed to achieve this: `CompareResult.overrides`
> is still full-stack on the wire, `DiffRow` is still an N-column renderer, and the reduction is a
> single filter at the column-building seam (`buildColumns`), so restoring the full grid is
> re-widening that filter rather than rebuilding the view. Read every "one column per plugin"
> statement below as describing that deferred design. Where a statement is about *how a column
> behaves*, it still holds — of the one column that renders.

An editor-tab webview presenting a **compare grid**: one row per field, one column per plugin
containing the record, in load order — master on the left, winning override on the right — with
per-cell conflict color coding from the two-axis model
([ADR-0016](../adr/0016-two-axis-conflict-model.md)). Values render as what they mean (flag
names, EditorID links) rather than as what they are stored as.

Editing is in-place and writes the record's working-tree source text directly (ADR-0041) — there
is no intermediate staged state. Save & Compile and review/commit are separate gestures, specified
in [medit-version-control.md](medit-version-control.md).

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
   around — the same gesture xEdit uses.
6. As a user, I want structs and arrays shown collapsed with a summary and expandable to their
   sub-fields/elements, so that a complex record stays readable.
7. As a user, I want to focus a field with a click and open its editor the way xEdit does — a
   second click, `F2`, or a double click — getting the right input for its type (text, number,
   toggle, dropdown, flag multi-select, FormKey picker), so that editing is type-appropriate, I
   can't enter a nonsensical value, there is no mode to enter first, and only one cell is ever an
   input so the grid stays readable.
8. As a user, I want to collapse a plugin column to just its header chip, with the state
    remembered, so that I can focus the grid on the plugins I care about.
9. As a user, I want to click any cell — including one in a read-only plugin — and press `Ctrl+C`
    to put its value on the clipboard, so that I can lift a value out of the grid to use in a
    script, a patch, or another tool without retyping it. Copy takes the cell's value, not
    whatever text I could select, so it works the same on a flag list, a dropdown and a reference
    as it does on a string.
10. As a user, I want to rename a mutable record's FormID, with validation that the new id is
    free and that immutable references don't block it, so that renumbering is safe and the
    errors are explained rather than silent.
11. As a user, I want to inspect and edit a record's Papyrus (VMAD) script data — scripts,
    their properties, and nested array/struct/structList values — so that I can reconcile
    script conflicts in the same grid as the rest of the record.
12. As a user, I want null/missing fields shown as empty cells (never "null"/"undefined") and
    read-only cells in immutable columns to render no input on click, so that the grid reads
    cleanly and never invites an edit that can't happen.

## Implementation Decisions

### Interaction model

**xEdit's model, ported** — the one compare grid, whose rows include VMAD and Condition data as
ordinary rows (see below)
([ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md); the behaviour being matched is catalogued in
[the xEdit UX audit](../research/xedit-ux-audit.md)). Every user of this panel arrives fluent in
xEdit, so it is the reference, and divergence needs a platform limitation to justify it — not a
better idea.

- **Left-click** — **focus this cell.** The row highlights; one cell within it carries focus. That
  is all a single click does: never edit, never navigate, never reveal, never a menu. Selection is
  single-cell, single-row — no ranges. The focused cell is what the keyboard then acts on, which is
  the whole reason click is spent on focus rather than on editing.
- **Left-click on the already-focused cell** — open its inline editor. The Explorer
  "click, then click again to rename" pattern, and xEdit's `toEditOnClick`.
- **Double-click a value cell** — open the same inline editor a second click/`F2` on the
  already-focused cell would: numeric and flag types inline, `string` inline too
  ([ADR-0039](../adr/0039-no-left-click-leaves-the-record-panel.md) — no left-click gesture
  may reach the extended editor, which used to be `string`'s own double-click target). A FormKey's
  double click stays on the native QuickPick, same as its second click/F2 — that QuickPick is
  already its richest editor (ADR-0034's divergence #1). **Double-click the label column** —
  expand/collapse that node.
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
  resting cell shows the default arrow, as in xEdit. `grab` on every value cell was the earlier
  model's attempt to make one cursor state two gestures at once; with click meaning focus there is nothing
  for the cursor to disambiguate.
- **Right-click** — the only place a named, discrete action lives. On a **value cell** that is the
  list structure ops (**Add** / **Remove** / **Move Up** / **Move Down** — there is no **Clear**),
  which are
  also the `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓` accelerators above — the menu is the canonical
  definition and the keys are shortcuts onto it, exactly as in xEdit, and there are **no inline
  ▲▼✕ controls**, per the no-second-route rule below. On a **`string` value cell**, right-click also
  offers **Open in Editor…** (ADR-0039) — the extended editor's only remaining trigger, on
  mutable and immutable columns alike; see *Editing* below for what opens. The column-header menu is VS Code's own
  native context menu (`contributes.menus["webview/context"]`, gated on a `data-vscode-context`
  attribute the header carries — [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md)'s
  native-first precedent applied inside the webview) rather than a rendered overlay. Per ADR-0038
  there is no Add Master… — masters are
  lifecycle-derived, never a direct user edit; the header record's masters field shows on this
  column header, read-only, derived from content at compile (Effective masters — the plugin's
  committed masters unioned with the origins of every currently uncommitted working-tree change,
  ADR-0038).
- **Ctrl+click** — acknowledged for now as a fourth, navigation-only gesture (follows a FormKey
  reference to its record). Whether it survives once a right-click "Go to Record" exists is still
  undecided — see Further Notes.

No cell shows an affordance for an action it cannot perform. With click meaning focus, that is a
much smaller claim than it was under the earlier click-to-edit model: the cursor is the default arrow everywhere, drag is
unadvertised (as in xEdit), and the only resting affordance is the Ctrl-hover link underline on a
reference that actually resolves.

### Gesture matrix

Where each gesture is available. Under
[ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md) this is nearly uniform,
which is the point — the previous model's availability holes were consequences of routing copy
through DOM text selection, and they close when the clipboard carries the model value instead.

#### Uniform across every value cell, both column kinds

Focus on click · drag out · `Ctrl+C` copy · right-click menu · default arrow cursor. Every scalar
type's second click, `F2` and double click now agree on the same (inline) editor —
`string` included ([ADR-0039](../adr/0039-no-left-click-leaves-the-record-panel.md)) — so
there is no per-type exception left in this table at all.
Drop in and all mutating operations (`Ctrl+V`, `Ctrl+X`, `F2`, `Insert`, `Delete`, `Ctrl+↑`/`↓`,
editing of any kind) are **mutable columns only** — an immutable cell simply refuses, showing no
distinct affordance beforehand, exactly as xEdit does. A `string` cell's right-click menu is the
one exception offered on **both** column kinds — **Open in Editor…** opens the extended editor,
read-only on an immutable/untracked/not-in-load-order column (ADR-0039).

#### By cell

| Cell | Second click / `F2` / double-click opens |
| --- | --- |
| `string` | text editor (right-click: **Open in Editor…**, the extended editor) |
| `int`, `float` | number editor (inline — matches xEdit's `dtInteger`/`dtFloat`) |
| `bool` | checkbox |
| `enum` | dropdown |
| `flags` | multi-select checklist (xEdit's `dtFlag` is inline) |
| `formKey` | native QuickPick |
| empty (`—`) | the type's editor (mutable only) |
| struct / array summary | nothing (double-click: expand/collapse) |
| label column | — (double-click: expand/collapse) |

The only cells that open *nothing* are struct and array summary rows, which render a placeholder
(`{…}`, `[3]`) rather than a value. They remain focusable, copyable and draggable — dragging one
copies the whole structure, as xEdit does when you drag by the header.

#### Why copy is uniform now

`Ctrl+C` copies the focused cell's **model value**, the same string its editor would show — xEdit's
`Element.EditValue`. It never reads DOM text and never needs a selection, so it does not care which
widget the cell renders. That removes the old model's two holes at once: `bool`/`enum`/`flags` on a
mutable column had no copy path because their editor was a control rather than text, which produced
the inversion where a read-only column could hand over its value and an editable one could not.
Neither survives. One function, `modelValue` (webview `modelValue.ts`), defines this string per
field type and is the only place either the copy path or a leaf's own display/editor reads it from
— string/int/float/bool/enum pass through unchanged from what the editor already showed; flags
render their active names, comma-separated, never the bitmask; a FormKey renders the same
`EditorID [FormKey]` composite the picker and `FormKeyLink` already use.

**Struct and array summary rows are the one exception to "the same string the editor shows"** —
they have no editor to match, since a compound field is edited through its child rows, not as a
unit. Their model value is a **JSON serialization of the field's current value**, not an xEdit-style
`Element.Summary` human-readable string, even though xEdit's own model has one. A faithful
`Element.Summary` equivalent needs per-record-type domain knowledge this codebase doesn't have
anywhere yet — how to render a REFR's position, a condition's function call, an arbitrary nested
struct — and would be its own open-ended design effort, not a sub-decision inside a copy-command
ticket. JSON needs no per-type knowledge, is honest about what a struct/array actually is
rather than a lossy gloss of it, and is genuinely round-trippable (`JSON.parse` recovers the same
value) — a prose summary is neither. This is a deliberate, bounded divergence from xEdit's exact
behavior for a content-generation question a UX-parity ticket shouldn't have to answer, not "an
alternative that seems nicer" for a gesture ADR-0034 would otherwise forbid diverging on.

#### Ctrl+X only actually clears some types

`Ctrl+X` copies the focused cell's model value, then attempts to clear it by running `''` through
the same coercion `Ctrl+V` uses for a pasted string — there is no separate, per-type "default
value" table. `''` coerces cleanly for `string` (the empty string itself), bitmask `flags` (no
active bits), and `formKey` (no reference), so those three types are the ones Ctrl+X visibly
clears. It does **not** coerce for `bool`, `int`, `float`, or a plain (non-bitmask) `enum` — none
of those has an empty representation — so on those types Ctrl+X only copies; the value on screen is
left exactly as it would be by pasting a clipboard string that fails to coerce (the general
"cannot coerce, leave the field unchanged" rule above, applied to Cut's own internal `''` paste).
This is also why Ctrl+X does nothing at all — not even a clipboard write — on a cell that is
already empty: matching xEdit's own guard (`Element.EditValue` must be non-empty before Cut acts,
[xEdit UX audit](../research/xedit-ux-audit.md)), there is nothing to cut.

### The panel

- A webview panel opened by `modbench.openEditor`; **one singleton panel**, reused/retargeted
  when navigating between records (an extension invariant). `modbench.openEditorBeside` opens
  additional, independent panels beside it — as many as selected records — landing as tabs in
  one new editor group; only the singleton panel is reused. It is a React app.
- `modbench.openCompare` (command-palette only, no menu/keybinding) reveals the singleton panel
  if one is already open, or opens a fresh blank one if not — a way to bring the compare grid to
  front without going through a tree row. It never touches which record the panel shows.
- **Header**: record identity (`{RecordType} / {EditorID}`, or FormKey) and the FormKey
  (`{FormID}:{OriginPlugin}`), plain text — there is no in-panel Renumber control. Renumber
  ("Change FormID…") is a **tree-row** gesture: right-click a record node (or its context-menu
  entry), a native `showInputBox` prefilled with the next-free suggestion, accepting or typing
  over it; it writes a delete+create pair as an ordinary working-tree change. An
  in-use FormID surfaces an inline error in the input box; an immutable-reference block surfaces
  a notification naming the blocking plugins.
- **Compare grid** (the primary view): one **row per field** (fields with no value in any
  plugin hidden by default); one **column per plugin** that contains the record's FormKey, in
  load order (left = master, right = winning override) — every column renders Effective state,
  committed text with any uncommitted working-tree change overlaid. Column headers show
  the plugin name as a chip, filename only — origin (the
  mod folder that provided this copy, or a reserved value) lives in the chip's tooltip always, and
  renders inline in the label only when a second loaded copy shares this filename (ADR-0036).
  An immutable chip carries a `(read-only)` note beneath it, worded by *why*: a vanilla/
  DLC/CC master reads `(read-only)`; a copy the effective load order does not name (ADR-0035)
  reads `(not loaded)` instead, and the whole column — header and every cell — renders dimmed, the
  one cue distinguishing it from a participating column once scrolled past the header. Both
  notes' tooltips name the reason. `(not loaded)`'s tooltip deliberately does not prescribe a
  single fix: `!InLoadOrder` covers two distinct causes the backend does not currently
  distinguish — a copy shadowed by another mod (a **file** conflict, decided by the Mod override
  order) and a plugin `plugins.txt` never lists at all (decided by the Plugin load order) — so the
  tooltip states the fact and names both surfaces that decide it (the Mods view, the Plugins view)
  rather than one gesture that would only fix one cause. Never "move it earlier in the load
  order" — that names the wrong axis for a shadowed copy (CONTEXT-MAP.md, CONTEXT.md). Left-click
  collapses/expands a column (state persisted for the panel's lifetime, not across restarts).
  The grid's scroll region is bound to the
  panel's viewport, not to its own content height, so a horizontal scrollbar (for wide grids with
  many plugin columns) stays reachable at the bottom of the visible viewport regardless of
  vertical scroll position, instead of only appearing at the bottom of a possibly very tall table.

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
  **QuickPick** (the webview cannot call `vscode.window.createQuickPick` itself, so this
  round-trips through the extension host), seeded with the current reference — as the same
  `EditorID [FormKey]` composite the cell displays and the picker's own items use, not the
  bare FormKey, so the input does not contradict the list beneath it — and filtered by
  `validFormKeyTypes`. The seed goes through the same normalization a pasted composite does, so it
  costs the search nothing. Typing searches records as you type (200ms debounce), matching EditorID
  or a FormKey-shaped query directly, with the same "EditorID [FormKey]" item labels
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
  fresh. A *mutable* FormKey cell's plain click is spent on the picker rather than an editor of its
  own, but that costs it nothing: `Ctrl+C` on the focused cell copies its model value the
  same as every other cell, independent of whether the picker is open. Seeding the picker with the
  composite makes the reference fully *visible* there too. The same picker backs the
  VMAD add-property dialog's Object-typed value and every VMAD object-property cell in the grid
  (`VmadObjectCell`, composing this same `FormKeyCell`). The link affordance appears on `Ctrl`-hover only when the
  reference resolves (rule 2 below); structs and arrays as a collapsed summary expandable to child rows,
  and are themselves drag sources for their whole value via that summary row, the same as a
  scalar leaf, collapsed or expanded alike.
- **A declined write is always a refusal, never a silent no-op reported as success**:
  a scalar or FormLink cell edit that the backend can't honor — a converter rejecting the typed
  value, an unparseable FormKey string, a property absent from the record's own concrete
  subclass — refuses naming the field, the same contract complex-field writes already had.
  A declined member inside an otherwise-valid struct/array write fails the whole
  write, not just that member; a member legitimately absent from a record's own subclass (the
  sparse leaf-union case, e.g. some OMOD property members) stays a silent no-op, since that's
  correct round-tripping, not a defect.
  **Nested Loqui struct sub-fields write through the same one path** (#643) — a struct member one
  or more levels inside another struct column, or inside an array element, applies with the exact
  semantics the top-level struct column has (one shared applier): abstract unions resolve their
  concrete leaf from the payload's own `concrete_type`, refusing when it can't be resolved; the
  existing value object is reused only when it is already the same concrete type; and a write with
  one bad member anywhere in the nested tree refuses the whole write before anything is written,
  leaving the working tree byte-identical.
  **Read/write symmetry is structural, not conventional** (#649). A leaf carries either a writer or
  a named read-only reason — `ColumnSpec.Apply`/`SubFieldSpec.Apply` are a two-case union, so a leaf
  that reads but silently cannot be written is no longer representable, and an audit asserts every
  writable-shaped leaf has one or the other. Classification is likewise total: every property the
  reflection walk reaches lands in exactly one structural class or is a **reported anomaly**, never
  silence. Shapes with no class yet are excluded by name with their live count, so a gap is a
  written-down decision rather than an absence — `IGenderedItemGetter<T>` (20 fields across Race,
  ArmorAddon, Armor, AssociationType and Rank), raw byte slices, `Percent`, `TimeOnly`, `RecordType`,
  `IReadOnlyArray2d`, `IReadOnlyDictionary`.
  **Atomic values are a table, not a handler branch.** `System.Drawing.Color` is its first entry,
  presented as xEdit presents it (`wbByteColors`): `red`/`green`/`blue` byte sub-fields, editable
  through the one write path like any struct member. Four fields — `ActionRecord.Color`,
  `Keyword.Color`, `LocationReferenceType.Color`, `Location.Color` — additionally carry `alpha`,
  matching the exact four xEdit renders with `wbByteRGBA`; the distinction is per *field*, not per
  type, and is not reflectable from Mutagen, so it is a transcribed allowlist in the same idiom as
  the vector-struct list. Editing a Color leaf preserves any existing alpha byte it does not name.
  **Naming a sub-field that genuinely has no write path is itself a refusal**
  (`RecordEditRefusal.NestedFieldReadOnly`, #642). Since #643 that is the unwritable residue only:
  nested condition data (its discriminator can never appear in a payload) and primitive-element
  nested lists (no element write path at any level — refusal is parity with their top-level
  columns, which already refuse as `FieldReadOnly`). Targeting one used to report success while
  discarding the value; it refuses the whole write instead, and the message says the sub-field is
  not editable rather than implying the value was invalid.
  Three cases stay distinct and must not be collapsed: a sub-field **absent** from the payload is
  skipped (absence is not targeting); the `value_type` and `concrete_type` **discriminators** are
  read off the raw JSON before the object exists and are deliberately never applied, so naming one
  is also a silent skip; only a sub-field the schema exposes with no write delegate refuses.
- **A `string` cell's right-click menu opens the extended editor** — **Open in Editor…**
  ([ADR-0039](../adr/0039-no-left-click-leaves-the-record-panel.md); ADR-0034
  divergence #2). xEdit's own answer for this surface is `TfrmViewElements`, a separate modeless
  window; a modeless Delphi form has no analogue worth reproducing in a webview (reproducing one
  would be exactly the chrome [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md)
  forbids), so the vehicle is substituted for a real **editor tab**, opened `ViewColumn.Beside` so
  the grid stays visible, non-preview so it isn't silently replaced by the next single-click
  preview elsewhere. xEdit's window also shows the value across every compared record; the grid
  already does that (one row, one column per plugin), so that half of `TfrmViewElements` isn't
  ported — the tab holds one plugin's value. The
  *trigger*, per ADR-0039: xEdit's own gesture for this (`EditTips`: *"Double click on text fields
  in the right pane to open multiline editor"*) opens its modeless form **over** the grid, leaving
  the tree and the user's place untouched — but the substituted vehicle is a VS Code tab, which
  **relocates** the user (the record panel loses focus, the active editor changes), an interaction
  xEdit itself never has. No amount of left-clicking may cost the user their place in the panel, so
  the trigger is right-click only, on mutable and immutable columns alike — a native
  `webview/context` contribution (`modbench.field.openExtended`, gated on the cell's own
  `stringValue` `data-vscode-context`, `recordUtils.ts`'s `stringValueContext`), the same mechanism
  every other row-level menu in this grid already uses.
  - **Vehicle**: a real OS temp file (`vscode.workspace.openTextDocument`/`showTextDocument`), not
    a `FileSystemProvider` and not an `untitled:` document. A real file gets genuine dirty-tracking
    and VS Code's own "Save changes to *X*? Save / Don't Save / Cancel" prompt on close-with-edits
    for free, so **abandoning it (closing without saving) commits nothing** without any bespoke
    code enforcing that; an **immutable** column's tab is `chmod`-ed non-writable before it opens,
    so it's **read-only, not absent** — VS Code shows a locked, uneditable editor for a
    non-writable local file natively, matching AC's "read-only over absent, if it's a coin toss": a
    read-only tab is still the only way to read a long value in full. Path is deterministic (keyed
    by record + field + plugin, not random), so re-invoking the command on the same cell reveals
    the already-open tab rather than opening a duplicate — VS Code's own per-URI reuse. The tab's
    own filename is what its title shows: `⟨Field⟩ [⟨Plugin⟩].txt` inside a directory named for the
    record (`⟨EditorID⟩ [⟨FormKey⟩]`, the same composite the header uses), so both which field and
    which record a tab belongs to are legible without opening it.
  - **Commit trigger**: on save. Each `Ctrl+S` writes the tab's full current content — never on
    keystroke (would write on every character typed) and never only on close (a user who saves
    twice while still editing expects both saves written, the same as re-editing any other cell
    twice). A string leaf nested inside a struct or array (any depth) commits through the same
    whole-field reconstruction inline edits use, not a bare value under the subtree root's
    path — the trigger carries the row's own path and the subtree root's field alongside the saved
    text. A top-level string field's commit is unaffected — the same value either way.
  - **Trigger gesture**: right-click only (ADR-0039). A `string` cell's second click, `F2` and
    double click all agree with every other scalar type on the inline editor, immediately, with no
    debounce — there is no second left-click target to disambiguate against.
  - **Scope**: every plugin column (`ScalarCell`/`DiffRow`). A plain `string`-typed row reaches the
    extended editor regardless of whether it's an ordinary field or a VMAD property (both fold
    onto the same `ScalarCell`). A composite leaf's own inner string widget (a condition
    parameter's Text category, `conditionParam`) doesn't yet — its outer `FieldMetadata.type` isn't
    `'string'`, which is what this menu entry keys on (a noted gap). A `string` cell that
    doesn't reach it keeps its inline editor on every left-click gesture, unchanged.
- **Unsorted array fields have arity and order operations** — **Move Up** / **Move Down** (swap
  with the neighbour) and **Remove** on an element row, and **Add** on the parent array row,
  appending a default-valued element. They live in the **right-click menu**, with
  `Ctrl+↑` / `Ctrl+↓` / `Delete` / `Insert` as accelerators onto the same menu items — xEdit's
  arrangement exactly, and required by the no-second-route rule: **there are no inline ▲▼✕
  buttons.** (Mechanism:
  a native `webview/context` menu on the element/parent cell, `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓`
  as DOM keydown accelerators on the focused cell, no extension-host round trip needed for the
  keys since `onArrayEdit`/`onArrayAdd` are pure in-webview state.) Add is available regardless of
  the array's expand state, matching xEdit. Sorted (`wbArrayS`) arrays offer none of these — order is derived from the
  sort key, so the entries are absent, not merely disabled. **The ops post a server-side op
  envelope** (`{op, path}`, #630) through the ordinary edit path; the backend reads the record's
  own current value, computes the result, and applies it as the same atomic whole-array
  complex-field write CONTEXT.md describes — so the write itself is unchanged, only who computes
  it. Boundary cases (move the first element up, the last down, remove an out-of-range index)
  are answered server-side as no-ops that commit nothing: no rewrite, no working-tree change, no
  history entry. Only non-immutable columns offer the ops. An element-**value** edit is offered on the same cell and shares this
  same reconstruction: the whole array (or struct-array element) is rebuilt before the write, so
  it lands atomically rather than being silently lost. The context-menu ops' wire payload
  carries the element's full `path` + `rootField` (the addressing contract), so ops on an
  array nested inside a struct or another array land at the element's real depth, and Add
  resolves its default element from the nested array's own element type via `metaAtPath` — a
  bare element index would truncate both. There is no free
  drag-reorder and no auto-sort.
  **Three surfaces are carved out of the generic envelope path and still compute client-side**:
  a **Condition** list, and VMAD's two non-scalar array shapes — **`ArrayOfObject`** and
  **`ArrayOfStruct`**. All are reached by the same generic `{ type: 'array' }` metadata and the
  same gestures, but none goes through the reflected-schema column the envelope path applies to —
  a condition-owning field is dispatched to `Fallout4ConditionCodec.ApplyListValue`, which
  requires a JSON array and refuses an envelope object.
  **A VMAD array-of-*scalars* property is no longer carved out** (#658): its arity ops became
  VMAD structural ops in `VmadCodec`'s own vocabulary — `add_element`, `remove_element`,
  `move_element_up`, `move_element_down` — computed server-side alongside `add_script` and
  `set_type`, which was the intended end state.
  **The client routes to the server on an allowlist, not a denylist**, and that is load-bearing:
  it posts an envelope only for the four scalar element kinds `VmadCodec` actually implements, so
  any other shape — including one added later — stays on the working client-side path and fails
  *closed*. The reverse (excluding known shapes) shipped briefly and broke `ArrayOfStruct`, which
  fell through to a `NotFound` refusal on a gesture that had worked. The client's allowlist and
  `VmadCodec`'s matched set have no runtime tie and must be changed together.
  The Condition and VMAD branches stay deliberately **separate, not one merged gate**: a
  Condition group's own `FieldDiff` is always a top-level entry, whereas a VMAD property's is
  nested under its script row, so a single top-level-keyed gate would misroute VMAD.
  **VMAD arity ops work as of
  #660**, which fixed the lookup: a property's `FieldDiff` sits two levels down
  (`wrapper → script → property`), so the old flat top-level search matched *nothing* under a
  VMAD path — every VMAD op through this handler was an unconditional silent no-op, before and
  after #630. The lookup now descends the VMAD subtree only; the Condition and ordinary-field
  lookups stay flat and untouched, because widening those would let a `rootField` resolve to a
  deeper node than intended and turn a silent no-op into a silent wrong write.
  VMAD's struct/structList element ops and
  Conditions' own add/remove/reorder are described under *VMAD and Conditions are ordinary rows
  in the one tree* below.
- **Editing writes working-tree source text directly** (ADR-0041) — there is no staged
  intermediate state. A single field's value can be **dragged between plugin columns** to copy
  just that field into the target (which must be editable; the source need not be) — or **copied
  and pasted** when the target isn't conveniently reachable by drag, or lives outside mEdit
  entirely: click the source cell, `Ctrl+C`, click the target, `Ctrl+V`. **Copy works on every
  cell of every type**, and paste on every cell of a mutable column, because
  the clipboard carries the cell's model value rather than selected text — there is no widget for
  it to be incompatible with. This is what `Ctrl+C`/`Ctrl+X`/`Ctrl+V` do in xEdit
  (`Element.EditValue`), and adopting it removes the previous model's two availability holes:
  `bool`/`enum`/`flags` having no copy path on a mutable column, and the resulting inversion where
  a read-only column could hand over its value and an editable one could not. Reviewing, committing
  and reverting a write happens in VS Code's native Source Control panel, not on this panel — see
  [medit-version-control.md](medit-version-control.md).
- There is **no per-plugin or per-record Save** on the panel — writing the binary is the separate
  Save & Compile gesture ([medit-version-control.md](medit-version-control.md)).

### Progressive load ([ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md))

A plugin's records are browsable — and therefore this panel is openable — the moment that plugin
is indexed, well before the winner sweep runs (the Plugins tree states the same fact,
[plugins.md](plugins.md)). This panel renders conflict colouring, which makes it the one surface
where **an absent conflict badge is indistinguishable from "no conflict"** actively misleads
rather than merely omits.

- **A record opened while the sweep is outstanding carries an explicit statement** that the
  comparison is incomplete and the colouring rendered from it is not final
  (`recordPanelIncompleteMessage`, `medit/loadOrderProgress.ts`) — an in-panel banner (a
  `WebviewPanel` has no native surface for a view-scoped statement the way a `TreeView` does). It
  clears itself, no user action, once the sweep lands.
- **Gate on `LoadOrderStatus.conflictsComputed`, never on "is a load running"** — the sweep is
  whole-set, so a live mutation can leave a *Ready* load order with stale winners this panel must
  still caveat.
- **A panel already open when the sweep lands refetches its comparison**, not just clears its own
  banner over stale content — the extension host broadcasts `CONFLICTS_COMPUTED` to every
  open record panel exactly once, from `EditingController.reportReconciled`, the one point a
  `putLoadOrder` call is known to have completed the sweep. No poller: the tick stream
  `plugins.md`'s own progress indicator polls (`GET /load-order/status`) stops at essentially the same
  instant the backend sets `conflictsComputed`, so it cannot reliably observe the transition —
  reusing the load's own completion is the reliable choke point instead.
- **Forward coupling:** the
  broadcast above fires only on the load-completing false→true transition. `conflictsComputed` is
  a separate field from load order state precisely because live mutation (reorder, enable, disable)
  will re-sweep a *Ready* load order and can leave it stale again — true→false, the opposite
  direction — and nothing described here observes that. Live mutation owes this panel the same
  notification on the way *out* of settled, or the banner silently stops working the moment that
  ships.

### Conflict color coding

The compare grid uses the two-axis model from
[ADR-0016](../adr/0016-two-axis-conflict-model.md). These two mappings are kept as tables
deliberately — they are enum→visual encodings that prose would only make less precise.

**Axis 1 — ConflictAll → row background.** `ConflictAll` is computed at two independent scopes
([ADR-0016](../adr/0016-two-axis-conflict-model.md)) — this table's
colors apply at both, only the *granularity of computation* differs:

- **Record-wide** (one value per record, `CompareResult.ConflictAll`): "the record's override
  stack as a whole" — carried on the wire for the compare endpoint's own response but not
  rendered by this grid, which paints from the per-node value below instead.
- **Per-node, bottom-up** (one value per compare-grid row, `FieldDiff.ConflictAll`): drives the
  compare grid's own row background. Each row paints from *its own* node, not the record-wide
  value — a leaf row (a scalar field, or an array/struct element with no children) colors from its
  own cross-plugin cell states alone; a struct/array row with children aggregates the worst state
  found anywhere in its subtree, recursively. **Collapsed**, that row shows the subtree's aggregate
  tint — collapsing must not hide that something inside differs. **Expanded**, it shows no
  background of its own — its now-visible child rows each carry their own individual tint instead,
  so the signal isn't duplicated or misattributed to a field that didn't change. A record with
  exactly one differing leaf field therefore tints only that field's row (and any collapsed
  struct/array ancestor of it) — every sibling and every agreeing field's row stays untinted, which
  is the whole point: an unchanged record, or an unchanged field within a changed record, carries
  no background color.

| ConflictAll | Row background | Meaning |
| --- | --- | --- |
| OnlyOne, NoConflict | No tint | Only in one plugin, or all overrides agree |
| Override | Subtle green | Overrides exist but no real conflict |
| Conflict | Subtle orange | Overrides disagree on a field |
| ConflictCritical | Subtle red | Injected record (FormKey origin not in a plugin's master list) whose overrides actually differ — content-identical injected records stay NoConflict; record-wide scope only — no per-node equivalent exists (a node is never itself "injected") |

No tint on `NoConflict`/`OnlyOne` is a **deliberate mEdit divergence** from xEdit's own default
palette, which tints even its no-conflict row state — not an oversight. Reserving "has a
background color" for "something here actually needs attention" is the signal a record-wide
smear would muddy.

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

### Partial Form overrides

**Partial Form** is record-header flag bit 14 (`0x4000`; CONTEXT.md's own glossary entry) on CELL,
WRLD, DIAL and QUST: an override that exists only to carry children, whose own fields the game and
xEdit ignore, falling through to the previous non-partial override instead. xEdit's own
`GetWinningOverride` (`wbImplementation.pas`) walks load order skipping any Partial Form override
to find the record whose fields actually apply, and its write path (`AssignInternal`) refuses
every field but EDID once the flag is set. Applies to plugins loaded today independent of any copy
gesture — Sim Settlements 2 is a real-world example on Fallout 4.

- **Type-gated, not a bare bit test.** Bit 14 is reused for unrelated meanings on record types that
  never declare a `'Partial Form'` flag at all, so a record's own concrete type must be one of the
  four container types (Cell/Worldspace/Quest/DialogTopic — `ContainerChildFields`'s own table)
  before the bit means anything. A container type is the domain-correct gate regardless: Partial
  Form exists specifically so a container can carry children without asserting its own fields, so
  only a type with children to carry can ever need it.
- **Conflict exclusion.** A Partial Form override's own fields are excluded from conflict
  classification entirely — treated as absent for every purpose ADR-0016's existing PartialForm
  absent-field rule already covers (winner/contest/cell-state candidacy), regardless of whether the
  field is literally JSON `null` or carries a real, differing value. A cell whose only override
  beyond the master is a Partial Form record therefore classifies `NoConflict`, not `Override` or
  `Conflict`, even when that override's own field genuinely differs byte-for-byte from the master's
  — its own change is out of scope for conflict purposes, full stop, the same way CONTEXT.md's
  Partial Form entry states it. `FieldDiff.WinnerColumn`/`WinnerValue` fall through to the nearest
  plugin that actually carries a value for that field, not the record-wide winner, so a field the
  winning override never touches reports the real effective value rather than a blank one.
  **Children are unaffected** — a placed reference (or other embedded child) the override
  introduces is a separate record with its own FormKey, and classifies normally (typically
  `OnlyOne`, since it exists in only the one plugin that added it).
- **Column dimming, not hiding (AC3).** Unlike xEdit's own default of hiding a Partial Form
  record from conflict display entirely, the compare grid shows the column — mEdit's own
  never-hide-data posture — but visually marks it. **#618 narrows the reach of that posture
  without reversing it:** while the grid renders only the winning override, a Partial Form column
  is visible precisely when it is the winner, and is otherwise not rendered at all — along with
  every other non-winning column. The never-hide-data commitment is about not suppressing a column
  *within the stack the grid shows*; which columns the grid shows is the deferred question ADR-0019
  and ADR-0034 govern. The dimming below applies whenever such a column does render: the same
  `DIMMED_OPACITY` treatment a
  not-in-load-order column already gets, both at the column header and on every one of that
  column's own cells (read straight off `CompareOverride.IsPartialForm`, not a separately-computed
  set). A dimmed column is not a full competing override, matching what the exclusion above already
  computed.
- **Read-only except the header — and EditorID.** A Partial Form override's own fields refuse on
  the single write path (`RecordEditRefusal.PartialFormFieldReadOnly`) — a typed refusal, not just
  a UI disable, so an agent (ADR-0024) sees the same rule a human does. Checked against the write
  target, not the containing record, so an embedded child stays editable even though its Partial
  Form parent is not. **EditorID is exempt**, matching xEdit's own `CanAssignInternal`
  (`wbImplementation.pas:9905-9914`, "allow EDID for partial forms") — ADR-0034 makes that binding
  here rather than a scope choice this ticket could diverge from, and EditorID is an ordinary,
  already-writable field rather than part of the header's own flag-write surface, so the exemption
  needed no header write path to exist first. The record header itself — including clearing the
  flag, which restores full editability — is its own write surface (below).
- **Header write path clears the flag, restoring full editability.** A synthetic field
  path, `is_partial_form`, dispatched in `RecordFieldWriter.TryApply` the same way `editor_id`
  already is — the one sanctioned door, no second write surface. Flips bit 14 only (a byte-diff
  assertion checks no other bit or field moves) and is exempt from `PartialFormFieldReadOnly` so
  clearing is reachable while the flag is still set. **The generic-container gate, not a bare
  reflection check:** gated by the same `PartialFormFlag`/`ContainerChildFields` type table the
  read half uses (Mutagen's own static `IsPartialFormable` property doesn't cover every game's
  container types — FO4's own `Cell` is one of the gaps — so the write path can't rely on it
  either). A `PluginHeader` checkbox (rendered only when `CompareOverride.IsPartialFormable`) is
  the UI trigger, dispatching the existing `EDIT_FIELD` message — no new command or menu surface.
  **Closes the pre-existing second door:** the generic reflected columns mirroring the same
  underlying flags int (`major_flags`, `fallout4_major_record_flags` on FO4) remained a second way
  to flip bit 14 on a not-yet-flagged record even after the read half's refusal landed. `EditField`
  now refuses (`RecordEditRefusal.PartialFormFlagIndirectWrite`) any write through another field
  path that would move bit 14 as a side effect — a structural invariant, not a per-column name
  check, so it holds for any game's equivalent generic flags column without needing its own entry.
- **Out of scope here:** setting the flag (a container an editing gesture auto-creates carries it
  from creation) and a lightbulb offering it on an identical-to-master container (separate
  follow-up work).

### VMAD and Conditions are ordinary rows in the one tree

VMAD (Papyrus script data) and Conditions (CTDA) are not a separate section, table body, row
renderer, or cell renderer — they are ordinary rows in the same compare tree every other field
uses. Two pure frontend adapters, `vmadTreeAdapter.ts`/`conditionTreeAdapter.ts`, map the
compare response's `vmad`/`conditions` payloads into the identical node shape ordinary reflected
fields already carry (`FieldDiff`/`FieldMetadata`); RecordPanel merges the adapters' rows straight
into its own `diffs`/`fieldMetaMap` before handing the whole thing to the same recursive builder
described under *The panel* below. Nothing downstream of that merge point knows or cares which of
the three sources — reflection, VMAD, Conditions — a row came from: conflict coloring, expand/
collapse, focus, `F2`, the clipboard, and drag all come
from `DiffRow`/`RecordPanel` unchanged, not re-derived per surface. This is a rendering merge, not
a behaviour change: existing VMAD and Condition editing and conflict behaviour are
preserved end to end (verified by porting their prior test suites onto the unified tree), with the
handful of deliberate, called-out differences below.

**Each subrecord reaches the tree from exactly one of those three sources.** Schema reflection
excludes both condition-shaped properties and the virtual-machine-adapter property
from a record type's reflected columns, because the `conditions`/`vmad` payloads already carry
them in decoded form — reflecting them again would put the same subrecord in the grid twice, once
decoded and once as an opaque blob. Both exclusions are keyed on the game's own types rather than
on property names, so a game whose assembly has no condition codec or no VMAD interface excludes
nothing.

**Two frictions the adapters exist to paper over**, both additive extensions to the shared node
shape rather than a second shape:

- **Wire paths differ from display labels.** An ordinary field's `fieldName` and the path it
  writes under are the same string; a VMAD property's isn't (`"Health"` displays, but writes at
  `VMAD\ScriptName\Health`), and neither is a condition field's (`"Function"` displays, but writes
  at `CTDA\Conditions\0\Function`). `FieldDiff.wirePath`, when present, is what a row and its whole
  subtree actually write under — `RecordPanel`'s row-builder starts a **fresh** write root the
  moment it meets a child carrying one (rather than folding into whatever its parent writes),
  which is what lets a VMAD property or a condition field commit independently of the script/
  condition list containing it, exactly as it always has.
- **A written value's own shape can differ from the shared model's**, needed only for VMAD's
  Struct/ArrayOfStruct properties: their wire format is the backend's own raw node tree
  (`VmadStructEntry[]`/`VmadStructInstance[]` — `{name, type, boolValue, …, members}`), unchanged
  by this work (no backend/API change anywhere in it). `FieldDiff.commitOverride`, present only on
  those two property kinds, is the one escape hatch `RecordPanel`'s generic commit path consults
  instead of its default plain-object/array `setAtPath` — every ordinary field, every Condition
  field, and VMAD's own scalar/object/array-of-scalar properties never set it, so this is invisible
  to everything that doesn't need it.

**Synthesized metadata, the pattern the Condition section already proved applied more
broadly:** five leaf types exist only in synthesized `FieldMetadata` (`vmadObject`,
`conditionFunction`, `conditionRunOn`, `conditionComparison`, `conditionParam`) — the backend never
emits them. Each is a genuine exception to the plain type→widget mapping, the same way `formKey`
already is: a VMAD object property is a `(FormKey, alias)` pair (composes the shared `FormKeyCell`
plus an alias input — `VmadObjectEditor`); a condition's Function opens a
QuickPick over the function catalogue, never a text/dropdown editor; Run On, Comparison, and a
parameter each pick their own widget from their own current value's shape (a `{target,
reference}` pair; a plain number vs. a GLOB FormKey string, distinguished by JS type rather than a
sibling Use-Global flag this row has no access to; a `{category, …}` tagged union) rather than a
second per-plugin metadata branch `DiffRow` would otherwise need. Run On's own target enum is
likewise a server catalog (`GET /condition-run-on-targets`, `RecordPanelClient
.conditionRunOnTargets()`), fetched once by `RecordPanel` and threaded through
`buildConditionRows`/`conditionTreeAdapter.ts` into the field's own `enumValues` — not a hardcoded
frontend list, so a future game's differently-shaped `RunOnType` enum (Skyrim/Starfield both differ
from FO4's) is never silently offered a name it can't parse or write. The AND/OR gate between
conditions is `FieldMetadata.readOnly` — unconditionally non-editable regardless of the column's
own mutability, the one per-row override on top of the immutableSet-driven per-column rule
everything else still uses unchanged.

**VMAD's shape**: one always-present top-level row, **"Scripts (VMAD)"** (a struct-like
container — `{…}` collapsed, no editable value of its own), whenever the record type is
VMAD-capable (`hasVmad`), even with zero scripts — the stable home "Add Script" needs, since
unlike a condition-owning field a scriptless record's `vmad` payload can be entirely absent, not
merely an empty list. Each **script** is its own struct row beneath it: a read-only **Flags**
child (editing moves to the right-click menu, see below) followed by its **properties**, each
carrying its own `wirePath`. A property's own kind decides its row: scalar/object kinds are plain
leaves; **array** (`ArrayOf` Bool/Int/Float/String/Object) reconstructs a real per-plugin array
(not the raw compare payload's `null`-for-containers convention) so it fits the exact shape an
ordinary unsorted array already does — meaning the **existing** array-op machinery (right-click
Add/Remove/Move Up/Move Down, `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓`) offers the same gestures on a
VMAD array. **This is no longer VMAD-free at the handler** (#630): ordinary arrays post a
generic server-side op envelope, and VMAD is handled on its own branch, because VMAD does not go
through the reflected-schema column that path applies to. **As of #658 a VMAD array of *scalars*
also computes server-side** — but in `VmadCodec`'s own vocabulary (`add_element`,
`remove_element`, `move_element_up`, `move_element_down`), not the generic array envelope. VMAD's
`ArrayOfObject` and `ArrayOfStruct` shapes remain client-side; the client selects by an allowlist
of the scalar kinds `VmadCodec` implements, so an unrecognised shape stays on the working path.
These
arity ops **were an unconditional silent no-op until #660** — a pre-existing lookup defect that
searched only the flat top level, where a VMAD property's `FieldDiff` never sits (it is two levels
down, `wrapper → script → property`). The same defect silently discarded a VMAD **string**
property's extended-editor save. Both now resolve. **struct**/**structList**
(ArrayOfStruct) use `commitOverride` as described above, with structList's own instances exposed
as array elements the same way (Remove/Move reuse the generic array machinery unmodified; instance
**Add** is the one case still awaiting a follow-up, noted below). A **variable**-kind property is
`readOnly` — it has never been editable.

**Conditions' shape**: one **`type: 'array'`** row per condition-owning field (not a struct
container the way VMAD's script list is) — a condition list's add/remove/move already wrote
the whole list at one field path before this work, the identical shape an ordinary unsorted array
writes in, so it reuses the **same** array-op gestures Conditions' AC asks for
("consistent with array operations") with **zero new commands**. As of #630 it is a **carve-out
at the handler**, not shared machinery: a condition-owning field is dispatched server-side to
`Fallout4ConditionCodec.ApplyListValue`, which requires a JSON array and refuses an op envelope,
so condition lists keep computing the whole array client-side. Review caught this as a live
regression when the envelope path first shipped without the carve-out — Remove on any Condition
row refused as "field not found". Conditions align across plugins
positionally by canonical index (the glossary's Unsorted array rule, ADR-0019, the same alignment
`VmadConflictClassifier` already gives VMAD arrays) — a plugin missing one condition leaves a hole
at that position rather than compacting the row list, so a condition's row stays aligned with its
own siblings across every plugin column; the array's own `commitOverride` strips those holes back
out immediately before any add/remove/move writes, since the wire list has no concept of "absent
here" the way a hole does. Each condition is a **struct** row, and its collapsed label is the one
deliberate exception to every other struct row's generic `{…}`: it shows xEdit's own one-line
prose summary (`wbConditionToStr`, `references/TES5Edit/Core/wbDefinitionsCommon.pas` —
`RunOn.Function(param1, param2) Op Comparison[ AND/OR]`, the trailing conjunction omitted on the
plugin's own last condition in the list), reformatted from the condition's own already-synthesized
fields (`conditionTreeAdapter.ts`'s `collapsedSummary`, consulted by `DiffRow` in place of the
placeholder). Ctrl+C/drag on the collapsed row are unaffected — they still copy the whole
condition as JSON (`modelValue.ts`'s struct branch, untouched), matching every other compound
field's "copy the real value" rule; only the *displayed* label diverges. Expanding one reveals its
typed fields — **Function**, each **Parameter**, **Run On**,
**Operator**, **Use Global**, **Comparison**, and the read-only **Type** (AND/OR) gate — each of
the first six carrying its own `wirePath` (`CTDA\FieldPath\Index\SubField`, `conditionPath.ts`),
so a field commits independently of its condition and of every sibling field, unchanged from
before. A parameter's input type (FormKey / number / string) is still resolved per-function from
Mutagen's typed getters, and switching a condition's Function still reshapes its parameter
storage at write time (`Fallout4ConditionCodec.ApplyFieldValue`) so no stale-shape value can
silently persist. The function picker is still the native QuickPick described previously,
listing `GET /condition-functions`'s server-filtered catalogue.

**Structural ops are right-click-menu commands**, consistent with every other structural op in
this grid (ADR-0034's no-second-route rule) — **Add Script**, **Remove Script**, **Add Property**,
**Remove Property**, **Set Script Flags**, and **Set Property Flags** are native `webview/context`
menu entries on the "Scripts (VMAD)" wrapper row, a script row, or a property row respectively
(`vmadScripts`/`vmadScript`/`vmadProperty` sections, the same broadcast-and-self-filter shape as
the array-op commands — the extension host has no live reference into the webview's React
state, so each command broadcasts to every open panel and each self-filters on `formKey`). A row's
`data-vscode-context` is not one exclusive slot: `combineVscodeContexts` (`recordUtils.ts`) merges
every context object sharing a row into one space-separated `webviewSection` token string, and
`package.json`'s own `when` clauses match their own token with `=~ /\btoken\b/` rather than `==`
— so a VMAD **array-of-scalars property**, which is simultaneously an array-op target
(`arrayParent`/`arrayElement`) and a VMAD structural-op target (`vmadProperty`), offers both
menus from the same cell, not whichever context happened to be built last. Set Script Flags seeds
its QuickPick with the script's own current flags (moved to front of the choice list, no
`activeItem` — the same "no default selection" convention the condition-function picker already
uses); Set Property Flags has none, matching property flags' set-only behaviour (a
property's current flags are never surfaced for reading, only ever defaulted to `'Edited'` by Add
Property). Add Script's own name collection is the native input box
(`vscode.window.showInputBox`, called directly by the command);
Add Property is the one deliberate webview-rendered dialog
(`ModalShell`/`AddPropertyDialog` — a deliberate exception: three fields at once, a multi-step
QuickPick chain would be worse UX) — the command only tells the webview which script/plugin to
open it for. Condition add/remove/reorder need no new commands at all (above). Each
condition-owning field is still keyed and written independently by its own field path
(`ConditionOwner.FieldPath`/`ConditionGroupDiff.FieldPath`, `Fallout4ConditionCodec.Extract`
reflecting over every top-level property shaped like a condition list), and a
condition-owning field still renders **only** as a condition row, never also as a raw generic
field (`SchemaReflector` excludes it from the generic reflection pass).

**Known, deliberately scoped gaps** (not silently dropped — each is a bounded follow-up, not a
design dead end): **Set Type** has no right-click entry yet (still reachable only by removing and
re-adding); a **structList instance's own Add** has no right-click entry yet — its `elementType`
has no `defaultValue` override the way a condition's does, and the raw node format
`defaultElementValue`'s own generic struct default would produce doesn't match it, so Add is
withheld outright there rather than writing a wrong-shaped instance (Remove/Move are unaffected —
neither needs a default, and both go through `commitOverride`'s own whole-array passthrough
correctly); a **not-yet-compiled** `add_script`/`add_property` structural op has no synthetic-row
visibility in the grid until it lands as real data (it's still fully valid to write and revert
through the native Source Control panel in the meantime); and the extended editor (right-click,
Open in Editor…, ADR-0039) reaches every plain `string`-typed row (including VMAD's own plain
String properties) but not yet a composite-typed leaf's own inner string widget (a condition
parameter's Text category) — its outer `FieldMetadata.type` isn't `'string'`, which is what that
menu entry keys on.

Condition lists nested one array level below the record (e.g. a magic Effect's own
`Effects[i].Conditions` on Ingestible/Ingredient/Spell/ObjectEffect, a Message's
`MenuButtons[i].Conditions`) are discovered by the same shape test applied to each array element,
keyed by an indexed field path composing the enclosing array's own name and index with the nested
list's own name (e.g. `Effects[2].Conditions`) — the existing `CTDA\<field path>\<index>\<subField>`
wire path treats that whole composed string as one opaque field path, so no DDL or wire-shape
change was needed. A path through a **Child record** (a record type Mutagen enumerates as
its own top-level row, e.g. Quest's `Scenes`/`DialogTopics`) is excluded, since that record already
surfaces its own conditions through its own top-level field. Nested groups align across plugins
positionally by the enclosing array's index and sort by that index numerically, not
lexicographically. Every condition-owning field's row is
an ordinary array row and defaults collapsed uniformly (rule 3 above), nested and flat alike —
one rule, no bespoke per-group default. Read-only for
now, on both ends: the frontend renders a nested group's rows display-only (no
function/parameter/operator inputs, no add/move/remove controls), and `PluginWriter.IsReadOnly`
rejects a nested (indexed) condition path at edit time as a second, independent gate. Editing at a
nested path stays rejected until scalar editing lands there; add/remove/reorder inside
a nested list, and two levels of nesting (a Perk effect's own conditions, a Quest
alias's/stage's own conditions), are further follow-ups.

Codec support is FO4-only today, reflecting Mutagen's four structurally different per-game
condition data shapes (no shared cross-game interface, unlike VMAD's `IHaveVirtualMachineAdapter`)
— a per-game `IConditionCodec` strategy resolved by `GameCategory` (ADR-0032); other games are
tracked separately. FormKey-typed condition parameters, the Run On reference, and a
Use-Global comparison target each resolve through the same backend signal VMAD uses — link
label and affordance follow the real resolution, not a raw FormKey — and each is fed into
`form_references`, so a record referenced only by a condition now surfaces in Referenced By.

### Field type rendering rules

These apply everywhere a field value is rendered — the one compare grid and any future surface,
VMAD/Condition rows included since they render through this exact code now:

1. **Never display raw integers for enums or flags** — always resolve to name(s).
2. **FormKeys render as links**, labelled `EditorID [FormKey]` when the reference resolves and the
   bare FormKey when it doesn't — the same composite the picker's own items have always used, so
   the format a reference is *chosen* in and the format it is *read back* in are identical.
   Labelling with the EditorID alone is wrong: a FormKey is the identity and
   the EditorID is decoration, and a cell that does not display its own identity cannot hand it to
   the user by any mechanism. Where
   the composite is too wide for its column it is truncated with an ellipsis, which does not
   truncate what a selection copies. The **link
   affordance** (underline, pointer) appears only while `Ctrl` is held and the pointer is over
   the cell, and only when the reference resolves (valid type *or* wrong type — xEdit allows
   following either); `Ctrl+click` follows it, and a link that does not look followable is not
   followable. This mirrors xEdit's `vstViewCheckHotTrack`, which gates hot-tracking on
   `Allow := Assigned(lLinksTo)` — a link you cannot follow must not look like one.

   The **field grid** (ADR-0031) sources both the label and the affordance from the
   backend's per-FormKey resolution signal on `FieldDiff` — a tri-state (unresolved /
   resolved-wrong-type / resolved-valid-type) computed server-side against the global FormKey
   index, carried independently per leaf so a dangling struct/array member never suppresses the
   affordance on the leaf next to it. One exemption to the index lookup: a FormKey in the
   engine-hardcoded range — ObjectID below the game's Mutagen `DefaultHighRangeFormID`, in an
   implicitly-always-loaded master — resolves valid *without* appearing in the index. Such a form
   (the Player, `00000007`, and friends) exists in no plugin's data, so a lookup miss on it can
   never mean the reference is broken; type-mismatch checking simply does not apply. This follows
   xEdit, which never reports that range as unresolved. `checkError` still drives the ⚠ icon but no longer gates
   the link.

   A VMAD object property (`vmadObject`, `VmadObjectCell`) sources the same signal from
   `VmadPropertyDiff.resolutions` — its link label and affordance follow the real
   resolution, not a well-formedness proxy, so a dangling reference (one pointing outside the
   index) no longer looks followable.
3. **Structs and arrays are always collapsible**, default collapsed; expand state is
   per-load order, not persisted across restarts. Array **element values** offer the inline-edit
   gesture everywhere (plain and struct-element arrays alike); committing one reconstructs the
   array's (or struct-array element's) whole value before the write, per the reconstruction
   CONTEXT.md's Complex-field entry's atomic-write model requires for a per-element gesture.
   Array **arity and order** are editable for **unsorted** arrays (add / remove /
   move-up / move-down, swap-based, on non-immutable columns) and **absent** for sorted
   (`wbArrayS`) arrays, whose order is sort-key-derived — these ops use the same
   whole-array reconstruction. A VMAD array-of-scalars property reuses this exact machinery;
   VMAD's own struct/structList element ops are described under *VMAD and Conditions
   are ordinary rows in the one tree* above. A list whose element's concrete type is
   polymorphic (OMOD `properties`' `AObjectModProperty<T>`, seven concrete leaves) resolves
   each element's own type from a `value_type` discriminator sub-field at write time; an
   element whose discriminator is missing or unrecognized refuses naming the field, rather
   than guessing or crashing — the same polymorphism applies read-side.

   Mutagen's own generated code has a second, more common shape for a polymorphic field: an
   abstract `A<Name>` base (`ANpcLevel`, `AQuestAlias`, ...) whose real per-subclass data lives on
   concrete classes that *inherit from* the base, rather than the OMOD-only leaves (generic
   sibling interfaces the base never inherits from, each needing its own hand-verified value-type
   table). The same discriminator pattern generalizes reflectively — `SchemaReflector` finds
   every concrete subclass of an abstract base in the same Mutagen assembly, exposes each leaf's own
   members as a sparse union keyed by a synthesized `concrete_type` sub-field (the leaf's own class
   name, e.g. `"NpcLevel"`/`"PcLevelMult"`, `"QuestReferenceAlias"`/`"QuestLocationAlias"`/
   `"QuestCollectionAlias"`), and writes back by resolving `concrete_type` the same way OMOD's
   `value_type` resolves — no per-type table, and OMOD's own `BuildObjectModPropertyLeafFields`
   stays alongside it unmerged, since OMOD's leaf discovery is a genuinely different mechanism (a
   generic base with no reflectively-enumerable subclasses of its own), not a special case of this
   one. `Npc.Level` (a single struct field, xEdit's `ACBS\Level`/`Level Mult`) and `Quest.Aliases`
   (a list field, xEdit's `ALST`/`ALLS`/`ALCS`) are the two mandatory record editor fields this
   closes; the mechanism also covers, as a byproduct, `Book.Teaches`, `ColorRecord.Data`,
   `Holotape.Data`, `SoundDescriptor.Data`, `Perk.Effects`, `MagicEffect.Archetype`,
   `AudioEffectChain.Effects`, `NavmeshGeometry.Parent` and `LocationTargetRadius.Target`. All nine
   have their write side compile-and-reparse verified (#611/#643,
   `MEditService.Tests/Edits/AbstractUnionCompileRoundTripTests.cs`), the
   same bar `Npc.Level`/`Quest.Aliases` themselves only gained there. Two of them,
   `NavmeshGeometry.Parent` and `LocationTargetRadius.Target`, are reached one level *inside* another
   struct column (`Static.NavmeshGeometry`/`Faction.VendorLocation`) rather than as a column of their
   own — #643 extended the write side down through nesting (`SchemaReflector.BuildStructSubField`
   wires the same shared struct applier `BuildStructColumn` uses, at every depth the read schema
   builds), so a nested struct sub-field writes with identical discriminator-resolution and
   refuse-before-attach semantics to a top-level struct column. Not every `A<Name>`
   type in the assembly qualifies: one (`ASceneActionType`) shares the naming convention without its
   generated class actually being `abstract`, so the mechanism correctly declines it (empty
   sub-schema, same as before) rather than guessing a discriminator scheme onto a type it cannot
   safely tell apart from an ordinary one. Its real discriminator is now known: a raw
   `ANAM` `UInt16` tag read by hand-written custom binary code, `4` selecting `SceneActionStartScene`
   and every other value collapsing into `SceneActionTypicalType`. It stays declined on purpose —
   Mutagen's own `Scene.xml` deliberately omits `abstract="true"` here where `Npc.xml` sets it for
   `ANpcLevel`, so `IsAbstract` is the *correct* signal rather than a false negative; and wiring it
   anyway would reach `SceneActionTypicalType`'s binary-overlay `Type` getter, which is an
   unimplemented `throw` upstream. The full scheme and both blockers are recorded on the
   `KnownGaps` entry.
   `Condition`/`ConditionData` and `AVirtualMachineAdapter` (VMAD) are *also* genuinely `abstract`,
   structurally identical to `ANpcLevel` — deliberately excluded by name
   (`SchemaReflector.AbstractUnionExcludedTypeNames`) rather than covered, because they are
   permanently outside the reflected schema by design (VMAD/condition reconstitution stays in
   `Queries/RecordDocumentCodecs`, operating on the document body — `MEditService/CLAUDE.md`); this
   mechanism could technically model them, and must not.
4. **A cell always renders Effective state** — committed text with any uncommitted working-tree
   change already overlaid; there is no separate dirty visual treatment on this
   panel. Revert is a git gesture in the native Source Control panel, not a cell-level control
   here ([medit-version-control.md](medit-version-control.md)).
5. **Null / missing fields** render as an empty cell, never "null"/"undefined".
6. **Read-only cells** in immutable plugin columns are never editable and render no input on
   click.
7. **A signature backed by several concrete Mutagen subclasses that declare the same list/struct
   field with genuinely conflicting element shapes** gets one of two treatments, both replacing
   "one column silently reads null for every subclass but the schema's discovery winner":
   - **Structurally different shapes** (no field names in common) get **one column per shape** —
     e.g. `dmgt`'s `damage_types` (struct elements) and `actor_value_indices` (scalar elements) are
     two separate columns; a given record's row is populated in whichever one matches its own
     subclass and empty in the other.
   - **Structurally identical shapes that disagree only on which member names a shared enum leaf
     allows** get **one merged column**, whose enum leaf's allowed values become the *union* across
     every subclass — e.g. `omod`'s `properties` column's `property` sub-field lists
     `ArmorModification`'s, `NpcModification`'s and `WeaponModification`'s member names together, so
     an `ArmorModification` row's own `property` metadata includes values (e.g. `ForcedInventory`,
     `AmmoCapacity`) that are not valid for that record's own subclass. This is a deliberate
     trade-off, not a display bug: `FieldMetadata` is column-wide (see below), so widening the
     allowed-value list is the only way every subclass's own values validate against it.

   Both differ from the *identical*-shape case, where a member declared on a shared ancestor
   already reads correctly off every sibling and needs no special handling at all. `FieldMetadata`
   itself stays column-wide in every case — there is no per-row element shape.

### Action logging

Editor interactions emit a leveled line on the **Modbench** output channel, so the
channel's native level filter controls volume. The webview has no channel of its own: it posts a
`LOG` message over the existing webview→extension-host bridge and the router dispatches it to the
channel at the carried level.

- **DEBUG** — the field-edit family: a committed disk-cell edit (VMAD/Condition leaves included,
  the same `handleEdit`/`handleVmadStructOp` call sites, not a separate log site per
  surface), a successful drag-copy between plugin columns, and array/VMAD-structural-op add /
  remove / move-up / move-down. These are high-frequency and fine-grained.
- **INFO** — discrete lifecycle operations: Remove.
- **WARN** — the system correctly refusing something: dropping a dragged value onto an immutable
  target column, which writes nothing.

Lines carry **identity only** — plugin, field path, and record FormKey — never the field's old or
new value, so a large array or struct edit can't flood the panel.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — given a compare
  response, assert what the grid renders (rows/columns, per-cell color from `cellStates`,
  enum/flag names resolved, FormKey links); given an edit interaction, assert the resulting
  `onEdit` write payload. No assertions about private component internals.
- **Seam**: the webview React components through their props, with the injected typed client —
  Vitest, `npm run test:unit`, no backend and no VS Code. Colocated tests per component, the
  established sibling-component pattern.
- **Record semantics and conflict classification** are the backend's responsibility and are
  tested there (`MEditService/CLAUDE.md`), not re-asserted from the webview; the frontend tests
  consume representative compare responses as fixtures.
- **Integration seam** (`npm run test:integration`, real VS Code process): navigation opens a
  record panel, and command registration holds.

## Out of Scope

- **Editing Papyrus source** — VMAD's own rows edit script *data* (properties, their values
  and types, script and property flags). Compiling or editing `.psc` source is a different job
  and is not this surface's.
- **Save and revert on this panel** — writing the binary is the separate Save & Compile gesture;
  reviewing and reverting a working-tree change happens in the native Source Control panel — both
  [medit-version-control.md](medit-version-control.md).
- **Referenced By** — a separate tree, [medit-referenced-by.md](medit-referenced-by.md).
- **Array arity/order editing of *sorted* (`wbArrayS`) arrays** — deliberately absent: order is
  derived from the sort key, so add/remove/reorder controls do not render on them. Unsorted
  (`wbArray`) arrays have field-grid arity/order controls (arity changes write the
  whole array as one field edit).

## Further Notes

- There is no edit mode (xEdit's `toEditOnClick` parity; column
  immutability already prevents accidental writes). Editability is per **column**, not a mode —
  the cells must know which columns are immutable, or a read-only column renders inputs
  the backend then rejects.
- **Open question: does `Ctrl+click`-to-follow survive alongside a right-click "Go to Record"?**
  [ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)'s gesture table lists
  `Ctrl+click` without resolving this. The tension: it's undiscoverable (no visible
  UI element hints at it) but is also shipped, xEdit-familiar muscle memory: removing it costs
  existing users a gesture they already rely on; keeping it alongside a menu item means two ways
  to do the same thing, the exact redundancy this ADR otherwise rules out everywhere else in this
  surface. Unresolved until decided explicitly.
