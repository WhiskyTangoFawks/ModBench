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
not a closed-cell paste of its own — see the FormKey paste note below. Array arity/order
ops live on the right-click menu with `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓` as accelerators, in the
two sets *Array arity and order* below defines — Add/Remove/Move Up/Move Down on an unsorted array,
Add/Remove alone on a keyed one; there are no inline ▲▼✕/＋
buttons. There is no read-only value
surface: an immutable cell opens nothing on plain click, second click, `F2`, or double click —
**a `string` cell included** (ADR-0039) — with Ctrl+C on the focused cell as every
immutable cell's copy path regardless, and the right-click menu's **Open in Editor…** entry (see
*Editing* below) as a long immutable value's own read path, read-only.

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

> **The grid renders the full override stack** — the multi-column description throughout this
> document is the shipped shape, per
> [ADR-0019](../adr/0019-xedit-unified-tree-model-for-compare-grid.md) and
> [ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md). The one narrowing
> is [ADR-0036](../adr/0036-plugin-identity-is-origin-plus-filename.md)'s
> file-level-loser exclusion: a losing physical copy of a duplicate-named plugin file
> (`Registration.Winning` false — never the broader `Participates`) is excluded backend-side at
> `RecordQueryService.GetCompare`, the single site a show-losing-copies toggle would
> parameterize.

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
    their properties, and nested array/struct values — so that I can reconcile script conflicts in
    the same grid as the rest of the record.
12. As a user, I want null/missing fields shown as empty cells (never "null"/"undefined") and
    read-only cells in immutable columns to render no input on click, so that the grid reads
    cleanly and never invites an edit that can't happen.

## Implementation Decisions

### Interaction model

**xEdit's model, ported** — the one compare grid
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
  may reach the extended editor). A FormKey's
  double click stays on the native QuickPick, same as its second click/F2 — that QuickPick is
  already its richest editor (ADR-0034's divergence #1). **Double-click the label column** —
  expand/collapse that node.
- **The keyboard acts on the focused cell** — `F2` edit · `Ctrl+C` copy · `Ctrl+X` cut ·
  `Ctrl+V` paste · `Insert` add a list entry · `Delete` remove the entry or clear the value ·
  `Ctrl+↑`/`Ctrl+↓` reorder within an unsorted list (a keyed list has no order to change). **Clipboard operations carry the cell's model
  value, not selected text**, so they work identically whether the cell renders a text box, a
  dropdown, a checkbox or a link, and in both column kinds. Copy needs no text surface and no
  selection, which is why neither exists here.
- **Click-and-hold, drag, drop** — copy this value's content directly into wherever it's dropped.
  Available from any cell regardless of the *source* column's mutability (only the drop target's
  mutability gates the drop); applies to compound (struct/array) fields via their header/summary
  row exactly as it applies to a scalar leaf's value. **The cursor does not advertise it** — a
  resting cell shows the default arrow, as in xEdit. With click meaning focus there is nothing
  for the cursor to disambiguate, so no cell advertises a `grab`.
- **Right-click** — the only place a named, discrete action lives. On a **value cell** that is the
  list structure ops (**Add** / **Remove** / **Move Up** / **Move Down** — there is no **Clear**;
  a keyed array offers the first two only),
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

The placeholder is a statement that a container is present and merely collapsed, so it is drawn
per column, not per row: a column whose plugin has nothing there — an array slot past its own
length, an abstract-union member its concrete leaf doesn't declare, a member of a struct the column
does not carry — renders an empty cell. The exception is a row *no* column carries a value for,
which holds nothing but its children and is therefore present in every column; it keeps its
placeholder throughout. **Absent means default** (ADR-0032): the document omits a member equal to
its default, so a scalar the column's own owner omits reads as that default — `0`, `false`, the
empty string, the enum default the metadata names, an empty flag set, `[0]` for a list — and its
editor opens on it. `—` is reserved for a link that is there and unset (`FieldMetadata.AllowsNull`
says null is a value); a byte slice, color or vector the document omits keeps it too, since the
metadata names no default text for them.

#### Why copy is uniform now

`Ctrl+C` copies the focused cell's **displayed value**, the same string the cell reads out — xEdit's
`Element.EditValue`, labelled where the schema labels it. It never reads DOM text and never needs a
selection, so it does not care which widget the cell renders. That removes the old model's two holes at once: `bool`/`enum`/`flags` on a
mutable column had no copy path because their editor was a control rather than text, which produced
the inversion where a read-only column could hand over its value and an editable one could not.
Neither survives. One function, `modelValue` (webview `modelValue.ts`), defines this string per
field type — string/int/float/bool/enum pass through unchanged from what the editor already showed;
flags render their active names, comma-separated, never the bitmask; a FormKey renders the same
`EditorID [FormKey]` composite the picker and `FormKeyLink` already use. `displayValue`, beside it,
is the one place that turns that into what the cell *reads out*, and is what both the copy path and
a leaf's own resting text ask — so what the user sees and what `Ctrl+C` hands over cannot drift.
The two differ for exactly one shape: an enum whose values are wire tokens rather than words (an
abstract union's `MutagenObjectType`), where the schema labels each value and the label is what
is displayed and copied. The editor still holds, and a payload still carries, the value itself.

**Struct and array summary rows are the one exception to "the same string the editor shows"** —
they have no editor to match, since a compound field is edited through its child rows, not as a
unit. Their model value is a **JSON serialization of the field's current value**, not an xEdit-style
`Element.Summary` human-readable string. That is the value the row copies and stages, so it is the
one that has to be honest about what a struct/array is and to round-trip (`JSON.parse` recovers the
same value); prose does neither.

**A collapsed array element may still *read* as prose**, through the **presentation table**
(`webview/src/presentation.ts`), whose entries
address an element's metadata, its value, the FormKey resolutions the diff already carries, and —
one level deep — how its children read. An element whose leaf has an entry renders that string in
place of `{…}` while collapsed; every other row is unchanged, and no entry affects the edit value or
the copy value. The table is the **only** place in the webview where a game's own reading
conventions live — a game-shaped rule anywhere else in `webview/` is in the wrong file. Its entries
are Fallout 4's two `Condition` leaves (*Conditions* below) and its `ScriptEntry`, `ScriptProperty`
and `ScriptObjectProperty` (*Scripts* below).

**The key is the leaf a value turned out to be, not the one its schema promised**: the value of
whichever member the schema marks as the discriminator (`MutagenObjectType`) where
the element has one, and `FieldMetadata.LeafTypeName` — the reflected type name, which the backend
sets on every `struct` and on nothing else — where it does not. A union is exactly where the two
disagree, so the discriminator answers alone: a union whose value names no leaf reads as nothing
rather than as its declared base, since a concrete base is one of its own leaves.

Three rules complete the lookup:

- **A leaf with no entry of its own reads by its declared base's entry.** A union's leaves mostly
  share one reading and differ only in which member holds the value — fifteen script-property leaves,
  one entry. This is reached only *after* the value has named a leaf, which is what keeps it distinct
  from the rule above: "the table knows only the family's reading" and "the value names no leaf" are
  different claims and get different answers.
- **A formatter may read its children's summaries, one level deep.** xEdit's summary passthrough
  (`SetSummaryPassthroughMaxDepth(1)`): a container reads as its children do, and a child whose own
  value is a list or a nested struct reads by name and kind alone.
- **An unreadable element inside a passthrough takes the grid's `{…}`.** Dropping it would make a
  two-property script read like a one-property script — the summary must have one entry per element
  the column holds.

#### Ctrl+X only actually clears some types

`Ctrl+X` copies the focused cell's displayed value, then attempts to clear it by running `''` through
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
  composite makes the reference fully *visible* there too. The link affordance appears on `Ctrl`-hover only when the
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
  **Nested Loqui struct sub-fields write through the same one path** — a struct member one
  or more levels inside another struct column, or inside an array element, applies with the exact
  semantics the top-level struct column has (one shared applier): unions resolve their
  concrete leaf from the payload's own `MutagenObjectType`, refusing when it can't be resolved; the
  existing value object is reused only when it is already the same concrete type; and a write with
  one bad member anywhere in the nested tree refuses the whole write before anything is written,
  leaving the working tree byte-identical.
  **A list of bare scalars writes through the same one path** — a string/number/hex-element
  list at the record's own top level (`race.movement_type_names`, `sndr.sound_files`,
  `mato.dnams`) and one nested inside a struct or array element
  (`race.subgraphs[].animation_paths`, `scen.actions[].npc_headtracking_actor_ids`) take the whole
  array as one value, and the ordinary array-op envelope (add/remove/move), exactly as a FormLink or
  struct-element list does. The element is built by the same `PrimitiveMap` converter its
  scalar-column twin uses, so an element the converter declines refuses the whole array before
  anything is attached. There is no length gate on a hex *element*, unlike a hex column: replacing
  the list gives an element no predecessor at its own position whose size it could have established,
  so a wrong-width element is caught by the compile that follows, if at all. A list whose element type
  reads but has no converter — a translated string, or an integer width `PrimitiveMap` lacks — is
  read-only under its own named reason; no Fallout 4 list is either, so the reason keeps the
  classification total rather than describing live data.
  **A new array element's default is the backend's, and names only the discriminator** — the
  Add gesture posts `{op: "add", path}` with no value, and `DocumentEdit` builds the element from
  the array's own element metadata. The default is the empty object: every member is left absent,
  so the codec's freshly built instance's CLR defaults stand. The one exception is a discriminator
  (`MutagenObjectType`), which the codec reads first to choose which concrete class to construct,
  before that object exists — so an element of an abstract-element array that omits it cannot be
  built and is refused `DiscriminatorInvalid`. A default element therefore carries its
  discriminator, set to the first leaf the schema lists, and the user changes it with the same
  `Kind` dropdown any other element uses. The webview computes no element of its own.

  **Read/write symmetry is structural, not conventional.** A leaf carries either a writer or
  a named read-only reason — `ColumnSpec.Apply`/`SubFieldSpec.Apply` are a two-case union, so a leaf
  that reads but silently cannot be written is unrepresentable, and an audit asserts every
  writable-shaped leaf has one or the other. Classification is likewise total: every property the
  reflection walk reaches lands in exactly one structural class or is a **reported anomaly**, never
  silence. Shapes with no class yet are excluded by name with their live count, so a gap is a
  written-down decision rather than an absence — `IGenderedItemGetter<T>` (20 fields across Race,
  ArmorAddon, Armor, AssociationType and Rank), `Percent`, `TimeOnly`, `RecordType`,
  `IReadOnlyArray2d`, `IReadOnlyDictionary`.
  **A byte slice is a hex leaf.** `ReadOnlyMemorySlice<byte>` reads and writes as `"0x"` followed by
  uppercase hex — Mutagen's own document spelling, so the reflected column and the `json_extract`
  view over `records.body` agree on the text. The writer refuses a non-hex value, and refuses any
  length change to a slice that already has one, which is what holds fixed-size subrecords to their
  size without a hand-written table. The exclusion survives only for the two slices whose elements
  are not bytes — `Weather.CloudTextures` (`<String>`) and `Weather.NAM4` (`<Single>`) — which are
  list shapes rather than blobs. A byte slice appearing as a *list element* (`dlvw.tnams`,
  `mato.dnams`, `pack.procedure_tree[].unknown`) reads and writes in the same grammar, through the
  list's own applier.
  **Atomic values are a table, not a handler branch.** `System.Drawing.Color` is its first entry,
  presented as xEdit presents it (`wbByteColors`): `red`/`green`/`blue` byte sub-fields, editable
  through the one write path like any struct member. Four fields — `ActionRecord.Color`,
  `Keyword.Color`, `LocationReferenceType.Color`, `Location.Color` — additionally carry `alpha`,
  matching the exact four xEdit renders with `wbByteRGBA`; the distinction is per *field*, not per
  type, and is not reflectable from Mutagen, so it is a transcribed allowlist in the same idiom as
  the vector-struct list. Editing a Color leaf preserves any existing alpha byte it does not name.
  **Naming a sub-field that genuinely has no write path is itself a refusal**
  (`RecordEditRefusal.NestedFieldReadOnly`). The residue is a nested
  struct with no usable write door — a getter type with no resolvable Loqui setter class, or an
  excluded union whose discriminator can never appear in a payload. Naming one
  refuses the whole write, and the message says the sub-field is not editable rather than implying
  the value was invalid.
  Three cases stay distinct and must not be collapsed: a sub-field **absent** from the payload is
  skipped (absence is not targeting); the `MutagenObjectType` **discriminator** is
  read off the raw JSON to decide which concrete type to construct, before the object any member
  could be applied to exists — so naming one is a silent skip at the member level, and the edit it
  carries has already been honoured by the enclosing object's own construction; only a
  sub-field the schema exposes with no write delegate refuses.
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
    twice). A string leaf nested inside a struct or array (any depth) commits the same `set`
    envelope the inline editor posts, at the row's own path — the trigger carries the row's path
    and the subtree root's field alongside the saved text. A top-level string field's commit is
    the one-hop form of the same envelope.
  - **Trigger gesture**: right-click only (ADR-0039). A `string` cell's second click, `F2` and
    double click all agree with every other scalar type on the inline editor, immediately, with no
    debounce — there is no second left-click target to disambiguate against.
  - **Scope**: every plugin column (`ScalarCell`/`DiffRow`). A plain `string`-typed row reaches the
    extended editor at whatever depth it sits. A composite leaf's own inner string widget doesn't — its outer
    `FieldMetadata.type` isn't `'string'`, which is what this menu entry keys on (a noted gap). A `string` cell that
    doesn't reach it keeps its inline editor on every left-click gesture, unchanged.
- **Array arity and order come in two sets, and one array kind has neither.** An **unsorted**
  (`wbArray`) array offers all four — **Move Up** / **Move Down** (swap with the neighbour) and
  **Remove** on an element row, and **Add** on the parent array row, appending a default-valued
  element. A **keyed** array — `wbArrayS` sorted by a key read off the element, addressed by that
  key rather than by index — offers **Add** and **Remove** and no **Move**: it is stored back in
  key order on every write, so no move a user could make would change the file. An array
  **sorted by its own element value** (a plain FormLink list,
  `FieldMetadata.ElementType.IsSortable`) offers none of the four, because its elements have no
  identity apart from their values. The entries a set does not include are absent, not disabled.
  They live in the **right-click menu**, with
  `Ctrl+↑` / `Ctrl+↓` / `Delete` / `Insert` as accelerators onto the same menu items — xEdit's
  arrangement exactly, and required by the no-second-route rule: **there are no inline ▲▼✕
  buttons.** (Mechanism:
  a native `webview/context` menu on the element/parent cell, `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓`
  as DOM keydown accelerators on the focused cell, each posting the same envelope the menu entry
  does.) Add is available regardless of the array's expand state, matching xEdit. **Every gesture
  is one envelope** — an operation, a path and an optional value, `POST /records/{formKey}/edit`'s
  own shape — and the webview posts what the user asked for and nothing else: `add` at the array
  with no value; `remove` at the element; `move` at the element with the destination position as
  its value (`Ctrl+↑` on the first element posts nothing, since the row's own hop says there is
  nowhere to go); `set` at a leaf with its new value. The backend resolves the path against the
  document it holds, patches, and answers with the result or a refusal naming the path — an
  element that is not there, a move off either end, is refused by name, never landed as nothing.
  Only non-immutable columns offer the ops. An element-**value** edit is offered on the same cell
  and is the same `set` at the element's own hop. The context-menu ops' payload carries the row's
  full `path` + `rootField`, so ops on an array nested inside a struct or another array land at
  the element's real depth. **A path is a chain of three hop kinds**, each as the diff node states
  it: a `member` names a struct's member; an `index` an unsorted array's element by its place among
  the array's children; a `key` a keyed array's element **by the key text the backend labelled it
  with**, which the backend resolves per column — the same key names a different position, or none
  at all, in each plugin's own array, which is exactly what lets a plugin carrying fewer scripts
  than its master read as an absence at those keys. An element of an array sorted by its own value
  sits at a different position in every column too, so its `set` carries an `index` hop found in
  the written column's own value at commit time. The webview holds no model beside the document:
  no path setter, no mirror of the backend's key rule, no cascade, no default table (ADR-0032).
  There is no free drag-reorder and no auto-sort.
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
  never-hide-data posture — but visually marks it. The dimming below applies to every rendered
  Partial Form column: the same
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
- **Header write path clears the flag, restoring full editability.** The flag is an annotated
  synthetic member, `IsPartialForm` (`SchemaAnnotations.SyntheticFlagMembers`): one bit of the
  record's `MajorRecordFlagsRaw`, written through the one envelope like every other member and
  patched by `DocumentEdit` onto the document itself. Flips bit 14 only (a byte-diff assertion
  checks no other bit or field moves) and is exempt from `PartialFormFieldReadOnly` so clearing
  is reachable while the flag is still set. **The generic-container gate, not a bare reflection
  check:** the annotation names exactly the container types the `PartialFormFlag`/
  `ContainerChildFields` type table admits (a test holds the two equal; Mutagen's own static
  `IsPartialFormable` property doesn't cover every game's container types — FO4's own `Cell` is
  one of the gaps — so the write path can't rely on it either). A `PluginHeader` checkbox
  (rendered only when `CompareOverride.IsPartialFormable`) is the UI trigger, posting
  `set` of `IsPartialForm` through the one envelope — no new command or menu surface.
  **Closes the pre-existing second door:** the generic reflected columns mirroring the same
  underlying flags int (`MajorFlags`, `Fallout4MajorRecordFlags` on FO4) remained a second way
  to flip bit 14 on a not-yet-flagged record even after the read half's refusal landed. A write
  through any other path that would move a synthetic member's bit as a side effect is refused
  (`RecordEditRefusal.SyntheticMemberIndirectWrite`) — a structural invariant read off the
  document before and after the codec round trip, not a per-column name check, so it holds for
  any game's equivalent generic flags column without needing its own entry.
- **Out of scope here:** setting the flag (a container an editing gesture auto-creates carries it
  from creation) and a lightbulb offering it on an identical-to-master container (separate
  follow-up work).

### Scripts are an ordinary reflected field

A record's virtual-machine adapter is a reflected **struct column**, `VirtualMachineAdapter`,
like any other — no section, adapter, codec, wire path, or command of its own. Its scripts are an
array of structs; each script's properties are an array whose element is the `ScriptProperty`
union, so a property carries a `MutagenObjectType` discriminator over its fifteen leaves and the
sparse union of their members, with a member whose shape disagrees across leaves one field whose
metadata carries a `Variants` map keyed by leaf (`Data`: an int under `ScriptIntProperty`, a float
array under `ScriptFloatListProperty`, …). Struct properties, arrays of structs, arrays of
scalars, quest fragments and quest alias scripts are all reached the same way. Every gesture —
cell edit, discriminator switch, add/remove/move — is the gesture that field kind already had.

**Some of those arrays are keyed, not positional.** xEdit declares them `wbArrayS`, sorted by a
key read off the element: scripts and alias scripts by script name, properties and struct members
by property name, PERK fragments by their index, QUST fragments by (stage, stage index), SCEN
phase fragments by (index, flags), and a quest's alias bindings by the alias number they name.
A keyed array is
[aligned across plugins by that key in the compare grid](../../MEditService/MEditService.Core/Queries/ConflictClassifier.cs)
rather than by position, so a plugin that carries fewer scripts than its master reads as an absence
at those keys instead of shifting every row after it; it is stored back in key order on every
write, whatever order the payload listed; and two elements sharing a key are refused
(`DuplicateKeyInKeyedArray`) naming the key, because the key identifies the element and the array
cannot represent two of it. A newly added element carries its discriminator and no other member
(see *A new array element's default is the backend's*), so its key is the empty key until the user
names it — adding a second unnamed element to the same array is exactly what the duplicate refusal
catches.

**How a collapsed script reads.** Three entries in the presentation table cover the whole family,
after xEdit's `wbScriptEntry` (`Core/wbDefinitionsFO4.pas:3956`), `wbScriptProperty` (`:3883`) and
`wbScriptPropertyObject` (`:3823`):

- a **script** reads `ScriptName(<each property>)` — its own name, then its properties passed
  straight through rather than counted;
- a **property** reads `Name: Kind = value`, where *Kind* is the schema's own word for the leaf,
  taken from the discriminator member's own label — never a Mutagen class name written here;
- an **object binding** reads as a property whose value is `Object, Alias[…]`, and read outside the
  property union — as an element of a plain list of bindings — as just `Object, Alias[…]`. One
  class serves both ways, and which it is, is what the presence of a discriminator label says.

Fourteen of the fifteen property leaves reach one entry through the base-entry rule; only the
object binding needs its own, for its value. **Passthrough stops at depth 1** (xEdit's
`SetSummaryPassthroughMaxDepth(1)`): a property whose value is a list or a nested struct reads by
name and kind alone, its value living on the rows it expands to, and a property with no reading at
all still contributes the grid's `{…}` so a two-property script never reads like a one-property one.

Three rulings inside that shape, recorded because they are rulings and not facts read off xEdit:

- **An alias slot reads `None` for -1, `Player` for -2, and its own number otherwise.** xEdit
  resolves a higher number through the owning quest's alias list; the compare wire carries no alias
  list, and a bare number is what xEdit itself prints with `wbResolveAlias` off, so the wire is not
  grown for this. If it ever is, the growth is precise: `FormKeyResolution` gains the resolved alias
  name for a member the schema marks as an alias index, populated backend-side like every other
  resolution — never a second lookup the webview performs.
- **No length cap.** xEdit's own caps (`SetSummaryPassthroughMaxLength`, 80 on a script's properties
  and 100 on the scripts list) answer a fixed-width tree column. The cell this lands in already
  ellipsizes at its own width, so the summary carries every element and lets the grid decide how
  much fits.
- **`', '` joins a passthrough's elements.** xEdit sets a delimiter per definition
  (`SetSummaryDelimiter`) for a struct's own members, but nothing in the clone shows how a
  passed-through *list* joins its elements — the machinery is absent
  ([ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)). Comma-space is the
  ruling — a delimiter the definitions do use (`SetSummaryDelimiter(', ')`), and the one that reads
  as a list rather than as one run-on token.

The arrays xEdit declares plain `wbArray` stay positional, and each is a fact rather than an
omission: INFO/PACK/SCEN fragment lists carry "do NOT sort" in the definitions themselves, an
array-of-struct property's instances are positional, and a scalar-array property's elements have no
key member at all.

**One shape is deliberately not modelled**: a struct property nested inside another struct member.
Fallout 4's Papyrus cannot author one (a struct member is never itself a struct), which is what
`SchemaAnnotations.CycleTruncations` names as the point the type walk stops; the walk would
otherwise re-enter `ScriptEntry -> ScriptProperty -> ScriptStructProperty` without end.

### Conditions

A condition list is an **ordinary reflected array-of-struct field**, at whatever depth it sits
(`Perk.Effects[i].Conditions[j].Conditions`, `Message.MenuButtons[i].Conditions`), with no section,
adapter, codec, wire path, or command of its own. `Condition` and `ConditionData` are each Loqui
unions, so each condition element carries a `MutagenObjectType` discriminator over its concrete
classes and the sparse union of their members; `ComparisonValue`, a float on one leaf and a GLOB link
on the other, is one field with a `Variants` map keyed by leaf, which is what
makes "Use Global" an ordinary discriminator switch that keeps every member the two leaves agree on.
Every gesture — cell edit, discriminator switch, add/remove/move — is the gesture that field kind
already had.

Two facts about a Fallout 4 condition cannot be read off a property, and enter as `SiblingsInUse`
annotation rows (ADR-0032) rather than as code: which parameter members a function actually uses
(read from Mutagen's own `Condition.GetParameterTypes`, the same table its writer switches on), and
that the Run On reference target is live only under the `Reference` Run On value. Both are
load-bearing on the backend: the form-reference and check-error walks skip a member the current
value says is idle, so a numeric parameter sharing its four bytes with a record link is not filed as
a reference, a Run On of Subject does not keep a stale target alive, and an idle reference is not
flagged as a dangling one.

The editor reads the same map, for the same two halves, over metadata alone — it names no game:

- **An idle member has no row.** A member the map governs and no column's current value puts in use
  is filtered out of the struct's child rows, so a condition shows one parameter row per slot the
  function actually uses and never the alias twin reading the same four bytes as the other type. A
  member *any* column puts in use is kept, so a losing override's own data is never hidden; a member
  no value ever names (`Unknown3`, xEdit's Parameter #3, written whatever the function is) is not
  governed at all and always shows. Filtering only ever removes a row the diff already has.
- **A change to a governing member empties what it idles — on the writer.** The webview posts
  the one leaf; `DocumentEdit` removes every governed sibling the new value does not put in use,
  so the slot reads absent (its default) on every write path. This is not cosmetic:
  `ConditionBinaryWriteTranslation.CustomStringExports` writes a CIS1/CIS2 subrecord for any
  non-null `ParameterOneString`/`ParameterTwoString` without consulting the function, so a string
  left behind by a function change would reach the plugin.

  A member the schema does not govern is never emptied by the cascade, and a stale value in one is
  still the author's to see and edit. A governed member that *is* idle has no row while it is idle:
  its value is either an alias of a live slot (the same four bytes read as the other type — showing
  it would be showing the same value twice, wrongly) or data no reader consults. The one divergence
  from xEdit is that xEdit renders CIS1/CIS2 as their own always-present rows, so a stale parameter
  string it would show is not shown here until the cascade clears it.

**How a collapsed condition reads.** Its presentation entry is xEdit's own `wbConditionToStr`
(`Core/wbDefinitionsCommon.pas`): the Run On prefix with its spaces stripped — or the reference in
parentheses where Run On is `Reference` — then the function and the parameter slots
`SiblingsInUse` says it uses, then the comparison operator, then the comparison value, then the
conjunction joining this condition to the next, absent on the list's last element. A slot Mutagen
carries as a string reads on its own row rather than in the call, exactly as in xEdit, and a call
whose first slot is left out has no parentheses at all. An operator outside the schema's own six
reads as no operator: the condition still reads, missing only the sign.

**The function picker is the schema's own enum.** On Fallout 4 that is the `Function` member's
479-member enum, rendered by the ordinary enum cell; on a shape whose `ConditionData` is one class
per function it is the `MutagenObjectType` discriminator dropdown, rendered by the same cell. No
picker command, and no catalog endpoint, exists on either shape.

Skyrim and Starfield are not built or tested in this repo; multi-game verification was descoped
and is not tracked. Their
`Condition.xml` declares the same abstract `Condition` with a `ConditionFloat` carrying a `Float`
`ComparisonValue` and a `ConditionGlobal` carrying a `FormLink` to `Global`, so the per-shape split
above is game-agnostic and needs no code for them. Their `ConditionData` is not Fallout 4's one
generic class: Skyrim has 426 per-function subclasses and Starfield about 610 plus an
`IConditionParameters` whose `Parameter1` is a bare `object`. Two things follow that any future
multi-game work has to settle rather than inherit: a bare `object` has no closed domain and lands
in `SchemaRefusals`, and
`LoquiUnions.BuildUnionShapeField` takes its metadata from the first declaring leaf alone — so
same-named parameters closed over *different* record types would share one shape key, not split, and
would silently advertise the first leaf's `ValidFormKeyTypes`. Fallout 4 never meets that: its
parameters close over `IFallout4MajorRecordGetter`, which names no type at all.

`GetEventData`, the second `ConditionData` leaf, is modelled but unreadable in the pinned Mutagen
(0.53.1): `GetEventDataBinaryOverlay` inherits `FunctionConditionData`'s member offsets, so reading
`Unknown3` off one runs past the end of the subrecord and no plugin holding one can be indexed at
all. That is upstream and predates conditions reaching the schema.

### Field type rendering rules

These apply everywhere a field value is rendered — the one compare grid and any future surface:

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
   xEdit, which never reports that range as unresolved. `checkError` drives the ⚠ icon but does not
   gate the link.
3. **Structs and arrays are always collapsible**, default collapsed; expand state is
   per-load order, not persisted across restarts. A row's label indents one step per ancestor
   hop, so a grandchild reads as sitting inside its parent rather than beside it. Array **element values** offer the inline-edit
   gesture everywhere (plain and struct-element arrays alike); committing one posts `set` at the
   element's own hop, and the backend patches that one node of the document.
   Array **arity and order** come in the two sets *Array arity and order* defines: **unsorted**
   arrays offer add / remove / move-up / move-down (on non-immutable columns), **keyed**
   arrays offer add / remove and no move (they are written back in key order regardless), and an
   array sorted by its own element value offers none — each is its own envelope operation at the
   array's or the element's path. A list whose element's concrete type is
   polymorphic (OMOD `Properties`' `AObjectModProperty<T>`, seven concrete leaves) resolves
   each element's own type from its `MutagenObjectType` discriminator sub-field at write time; an
   element whose discriminator is missing or unrecognized refuses naming the field, rather
   than guessing or crashing — the same polymorphism applies read-side.

   Mutagen's own generated code has a second, more common shape for a polymorphic field: an
   abstract `A<Name>` base (`ANpcLevel`, `AQuestAlias`, ...) whose real per-subclass data lives on
   concrete classes that *inherit from* the base, rather than the OMOD-only leaves (generic
   sibling interfaces the base never inherits from, each needing its own hand-verified value-type
   table). The same discriminator pattern generalizes reflectively — `SchemaReflector` finds
   every concrete subclass of an abstract base in the same Mutagen assembly, exposes each leaf's own
   members as a sparse union keyed by the document's own `MutagenObjectType` sub-field (the leaf's
   own class name as the codec spells it, e.g. `"NpcLevel"`/`"PcLevelMult"`, `"QuestReferenceAlias"`/
   `"QuestLocationAlias"`/`"QuestCollectionAlias"`), and writes back by resolving `MutagenObjectType`
   the same way OMOD's does — no per-type table, and OMOD's own `BuildObjectModPropertyLeafFields`
   stays alongside it unmerged, since OMOD's leaf discovery is a genuinely different mechanism (a
   generic base with no reflectively-enumerable subclasses of its own), not a special case of this
   one.
   **Every struct declares its own class**, union or not: `FieldMetadata.LeafTypeName` carries the
   reflected type name on every `struct` and is null on every other type. The discriminator is a
   different claim — the schema's name says which class was *promised*, the discriminator's value
   which one a value *turned out to be*, and a union is exactly where the two disagree.
   **Which leaf an element is, is itself an editable field.** `MutagenObjectType` is an `enum`
   over the union's leaves, so switching one is an ordinary edit of the enclosing struct/array:
   the editor resends the element with that one member changed, the write path builds the named
   leaf, applies every member the payload also names that the new leaf declares, and leaves the
   rest at the fresh instance's own defaults — the outgoing leaf's own members are dropped, not
   refused. The user is never shown a Mutagen class name: the reflected metadata labels the row
   (`FieldMetadata.DisplayLabel`, "Kind") and every value (each `EnumMember`'s own `Label`),
   each leaf named by what distinguishes it from its own base —
   `QuestReferenceAlias` under `AQuestAlias` is "Reference". That is a pure function of two type
   names, so it needs no per-game table; a leaf that *is* its base (`NpcLevel` under `ANpcLevel`)
   keeps its own name, spaced. xEdit's own per-field presentation of these choices arrives with
   the script-property surface.
   `Npc.Level` (a single struct field, xEdit's `ACBS\Level`/`Level Mult`) and `Quest.Aliases`
   (a list field, xEdit's `ALST`/`ALLS`/`ALCS`) are the two mandatory record editor fields this
   closes; the mechanism also covers, as a byproduct, `Book.Teaches`, `ColorRecord.Data`,
   `Holotape.Data`, `SoundDescriptor.Data`, `Perk.Effects`, `MagicEffect.Archetype`,
   `AudioEffectChain.Effects`, `NavmeshGeometry.Parent` and `LocationTargetRadius.Target`. All nine
   have their write side compile-and-reparse verified
   (`MEditService.Tests/Edits/AbstractUnionCompileRoundTripTests.cs`), the
   same bar `Npc.Level`/`Quest.Aliases` themselves only gained there. Two of them,
   `NavmeshGeometry.Parent` and `LocationTargetRadius.Target`, are reached one level *inside* another
   struct column (`Static.NavmeshGeometry`/`Faction.VendorLocation`) rather than as a column of their
   own — the write side was extended down through nesting (`StructLeaves.BuildStructSubField`
   wires the same shared struct applier `BuildStructColumn` uses, at every depth the read schema
   builds), so a nested struct sub-field writes with identical discriminator-resolution and
   refuse-before-attach semantics to a top-level struct column.
   A base need not be `abstract` to be a union: a concrete class with subclasses in the
   same assembly is one too, its leaves the subclasses plus the base itself — a script property
   (`ScriptProperty`, fourteen leaves, a bare `ScriptProperty` for a property of type None) is
   the case that matters, `Landscape.Layers`' `BaseLayer`/`AlphaLayer` the other one the shipped
   schema reaches. Where leaves declare a same-named member of *different* shape (a script
   property's `Data` is an int, a float, a bool, a string or a list of each, by leaf), the name
   stays one field whose metadata carries a `Variants` map, one shape per leaf, each written only
   onto a leaf of that shape. On write, a concrete-base
   union resolves its leaf from `MutagenObjectType` exactly as an abstract one does — an element
   sent without it is refused, never quietly built as the base. Expanding the struct
   leaf is what lets the walk reach `ScriptStructProperty.Members` -> `ScriptEntry.Properties`
   -> `ScriptProperty` again, so the walk keeps the getter types it is inside on its stack: a
   type re-entered on that path is a type cycle and fails schema generation naming the chain,
   unless the game's annotation table names it as a point its own data format cannot nest past
   (`SchemaAnnotations.CycleTruncations`; Fallout 4 Papyrus structs hold no struct or struct
   array, so inside either struct leaf neither is offered again and the walk ends there). A
   re-entry whose loop runs through such a point is let through for the same reason — every
   lap passes it, and it is entered once — which is what lets `ScriptEntry` be re-entered
   under a struct leaf's `Members` before the walk ends. That is a
   different mechanism from the depth cap, which bounds struct nesting and resets across a
   list hop.
   `ASceneActionType` is a concrete base with two leaves the mechanism must not expand
   (`SchemaAnnotations.ExcludedUnions`): its real discriminator is a raw `ANAM` `UInt16` tag
   read by hand-written custom binary code, `4` selecting `SceneActionStartScene` and every
   other value collapsing into `SceneActionTypicalType`, whose binary-overlay `Type` getter is
   an unimplemented `throw` upstream — wiring it would crash the first read of a real scene.
   `AVirtualMachineAdapter` (VMAD) is genuinely `abstract` too, and is modelled by this mechanism
   like every other union — as are `Condition`/`ConditionData`; all three were once excluded by
   name and none is now.
4. **A cell always renders Effective state** — committed text with any uncommitted working-tree
   change already overlaid; there is no separate dirty visual treatment on this
   panel. Revert is a git gesture in the native Source Control panel, not a cell-level control
   here ([medit-version-control.md](medit-version-control.md)).
5. **A member the document omits** reads as its default (*By cell* above); a member of an object
   the column does not carry renders an empty cell; nothing ever reads "null"/"undefined".
6. **Read-only cells** in immutable plugin columns are never editable and render no input on
   click.
7. **A signature backed by several concrete Mutagen subclasses** is one table whose document
   names the record's class first, carried as a `MutagenObjectType` discriminator column. A member
   every class shapes alike is one column; one they shape differently in any way — `dmgt`'s
   `DamageTypes` (struct elements on `DamageTypeIndexed`, scalar elements on `DamageType`),
   `omod`'s `Properties` (a different `Property` enum domain per modification class) — is one
   column whose metadata carries a `Variants` map keyed by record class, so a row reads and
   validates against its own class's shape. A member declared on a shared ancestor reads
   correctly off every sibling and needs no variant at all.

### Action logging

Editor interactions emit a leveled line on the **Modbench** output channel, so the
channel's native level filter controls volume. The webview has no channel of its own: it posts a
`LOG` message over the existing webview→extension-host bridge and the router dispatches it to the
channel at the carried level.

- **DEBUG** — the field-edit family: a committed disk-cell edit (one `handleEdit` call site, not
  a log site per surface), a successful drag-copy between plugin columns, and array add / remove /
  move-up / move-down. These are high-frequency and fine-grained.
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

- **Editing Papyrus source** — the adapter's own rows edit script *data* (properties, their values
  and types, script and property flags). Compiling or editing `.psc` source is a different job
  and is not this surface's.
- **Save and revert on this panel** — writing the binary is the separate Save & Compile gesture;
  reviewing and reverting a working-tree change happens in the native Source Control panel — both
  [medit-version-control.md](medit-version-control.md).
- **Referenced By** — a separate tree, [medit-referenced-by.md](medit-referenced-by.md).
- **Reordering any sorted (`wbArrayS`) array** — deliberately absent: order is derived from the
  key, and the array is written back in key order regardless, so no reorder control could change
  the file. A **keyed** array still has add and remove; an array sorted by its own element value
  has neither, its elements having no identity apart from their values. Unsorted (`wbArray`) arrays
  have all four field-grid arity/order controls (arity changes write the whole array as one field
  edit).

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
