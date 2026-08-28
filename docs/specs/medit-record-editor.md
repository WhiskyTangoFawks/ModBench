# mEdit Record editor panel — Surface Specification

**Status: Implemented.** Editing is git-native (ADR-0041): a field edit writes the record's
working-tree source text directly — there is no pending/staged intermediate state, no Pending
column, and no ChangeGroup. The grid, conflict colouring, and type-appropriate editors below all
ship and work on that write path. Review, commit, and revert happen in VS Code's native Source
Control panel, one repo per tracked mod — see
[Version control — Track, branch, compile](medit-version-control.md) for that surface; this
document covers the grid and its gestures only.
The **gesture model**: [ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)
was adopted after [an audit of xEdit](../research/xedit-ux-audit.md) showed mEdit had
specified single-click-to-edit, which xEdit does not do. In the field grid, a single click focuses
the cell — the row highlights, the focused cell is outlined, focus survives a re-render, and no
cell shows a `grab` cursor (#222). Editing is off single click: a second click on the focused
cell, `F2`, or a double click opens a mutable cell's editor; double-clicking the label column
expands/collapses that node; the editor selects its whole text on focus (#223). Every scalar type,
`string` included, agrees on this: second click, `F2` and double click all open the same inline
editor, immediately, with no debounce (#258/[ADR-0039](../adr/0039-no-left-click-leaves-the-record-panel.md)
— no left-click gesture may relocate the user out of the record panel, which a `string` cell's
double click used to do by opening a real editor tab). `Ctrl+C` copies
the focused cell's model value in both column kinds (#224); `Ctrl+X`/`Ctrl+V` are the mutating half
of that same contract — clipboard read/write both round-trip through the extension host, and both
commit through the ordinary onEdit path, coercing the pasted string the same way the typed-editor
path does (#225). A pasted reference into a FormKey cell still goes through its QuickPick editor,
not a closed-cell paste of its own — see the FormKey paste note below. Unsorted-array arity/order
ops (Add/Remove/Move Up/Move Down) live on the right-click
menu with `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓` as accelerators, and the inline ▲▼✕/＋ buttons #142
shipped before ADR-0034 are gone (#227). The read-only value surface the earlier click-to-edit model introduced is gone
too (#226): an immutable cell opens nothing on plain click, second click, `F2`, or double click —
**a `string` cell included, now** (#258/ADR-0039) — with Ctrl+C on the focused cell (#224) as every
immutable cell's copy path regardless, and the right-click menu's **Open in Editor…** entry (see
*Editing* below) as a long immutable value's own read path, read-only. Everything in
*Interaction model* below
describes the target, not the build. VMAD and Conditions now render as ordinary rows in this same
tree and inherit its focus model in full (#231 — see *VMAD and Conditions are ordinary rows in the
one tree* below for the handful of still-open, explicitly scoped gaps). Known gaps beyond that:
FormKey resolution (#141).

Editing context — operates on **records**, **FormKeys**, and **plugins**;
the Mod-Management vocabulary ("mod", "loadout", "deploy") belongs to the sibling surfaces, not
here ([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

One of the mEdit view's surfaces — see [medit.md](medit.md) for the shared session lifecycle,
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
the session. An editor that writes on keystroke, or that hides which plugin a value will land
in, produces broken plugins.

## Solution

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
ordinary rows (#231 — see below)
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
  (#258/[ADR-0039](../adr/0039-no-left-click-leaves-the-record-panel.md) — no left-click gesture
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
  list structure ops (**Add** / **Remove** / **Clear** / **Move Up** / **Move Down**), which are
  also the `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓` accelerators above — the menu is the canonical
  definition and the keys are shortcuts onto it, exactly as in xEdit, and there are **no inline
  ▲▼✕ controls**, per the no-second-route rule below. On a **`string` value cell**, right-click also
  offers **Open in Editor…** (#258/ADR-0039) — the extended editor's only remaining trigger, on
  mutable and immutable columns alike; see *Editing* below for what opens. The column-header menu is VS Code's own
  native context menu (`contributes.menus["webview/context"]`, gated on a `data-vscode-context`
  attribute the header carries — [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md)'s
  native-first precedent applied inside the webview) rather than a rendered overlay. #335/ADR-0038:
  Add Master… (and its own, deliberately-not-mutable-filtered QuickPick) is gone — masters is
  lifecycle-derived now, never a direct user edit; the header record's masters field shows on this
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
`string` included (#258/[ADR-0039](../adr/0039-no-left-click-leaves-the-record-panel.md)) — so
there is no per-type exception left in this table at all.
Drop in and all mutating operations (`Ctrl+V`, `Ctrl+X`, `F2`, `Insert`, `Delete`, `Ctrl+↑`/`↓`,
editing of any kind) are **mutable columns only** — an immutable cell simply refuses, showing no
distinct affordance beforehand, exactly as xEdit does. A `string` cell's right-click menu is the
one exception offered on **both** column kinds — **Open in Editor…** opens the extended editor,
read-only on an immutable/untracked/not-in-load-order column (#258/ADR-0039).

#### By cell

| Cell | Second click / `F2` / double-click opens |
| --- | --- |
| `string` | text editor (right-click: **Open in Editor…**, the extended editor — #258) |
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
`EditorID [FormKey]` composite the picker and `FormKeyLink` already use (#218).

**Struct and array summary rows are the one exception to "the same string the editor shows"** —
they have no editor to match, since a compound field is edited through its child rows, not as a
unit. Their model value is a **JSON serialization of the field's current value**, not an xEdit-style
`Element.Summary` human-readable string, even though xEdit's own model has one. A faithful
`Element.Summary` equivalent needs per-record-type domain knowledge this codebase doesn't have
anywhere yet — how to render a REFR's position, a condition's function call, an arbitrary nested
struct — and would be its own open-ended design effort, not a sub-decision inside a copy-command
ticket (#224). JSON needs no per-type knowledge, is honest about what a struct/array actually is
rather than a lossy gloss of it, and is genuinely round-trippable (`JSON.parse` recovers the same
value) — a prose summary is neither. This is a deliberate, bounded divergence from xEdit's exact
behavior for a content-generation question a UX-parity ticket shouldn't have to answer, not "an
alternative that seems nicer" for a gesture ADR-0034 would otherwise forbid diverging on.

#### Ctrl+X only actually clears some types (#225)

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

- A webview panel opened by `modbench.openEditor`; **one panel at a time**, reused when
  navigating between records (an extension invariant). It is a React app.
- **Header**: record identity (`{RecordType} / {EditorID}`, or FormKey) and the FormKey
  (`{FormID}:{OriginPlugin}`). On a mutable record the FormID is a 6-hex-char input with a
  **Renumber** button (enabled only when the value changed); on an immutable one it is plain
  text. Renumber writes a delete+create pair as an ordinary working-tree change (#427). An
  in-use FormID surfaces an inline error; an immutable-reference block surfaces a notification
  naming the blocking plugins.
- **Compare grid** (the primary view): one **row per field** (fields with no value in any
  plugin hidden by default); one **column per plugin** that contains the record's FormKey, in
  load order (left = master, right = winning override) — every column renders Effective state,
  committed text with any uncommitted working-tree change overlaid (#413). Column headers show
  the plugin name as a chip, filename only — origin (the
  mod folder that provided this copy, or a reserved value) lives in the chip's tooltip always, and
  renders inline in the label only when a second loaded copy shares this filename (ADR-0036;
  #304). An immutable chip carries a `(read-only)` note beneath it, worded by *why*: a vanilla/
  DLC/CC master reads `(read-only)`; a copy the effective load order does not name (#34, ADR-0035)
  reads `(not loaded)` instead, and the whole column — header and every cell — renders dimmed, the
  one cue distinguishing it from a participating column once scrolled past the header (#304). Both
  notes' tooltips name the reason. `(not loaded)`'s tooltip deliberately does not prescribe a
  single fix: `!InLoadOrder` covers two distinct causes the backend does not currently
  distinguish — a copy shadowed by another mod (a **file** conflict, decided by the Mod override
  order) and a plugin `plugins.txt` never lists at all (decided by the Plugin load order) — so the
  tooltip states the fact and names both surfaces that decide it (the Mods view, the Plugins view)
  rather than one gesture that would only fix one cause. Never "move it earlier in the load
  order" — that names the wrong axis for a shadowed copy (CONTEXT-MAP.md, CONTEXT.md). Left-click
  collapses/expands a column (state persisted in session). The grid's scroll region is bound to the
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
  fresh. A *mutable* FormKey cell's plain click is spent on the picker rather than an editor of its
  own, but that costs it nothing: `Ctrl+C` on the focused cell (#224) copies its model value the
  same as every other cell, independent of whether the picker is open. Seeding the picker with the
  composite makes the reference fully *visible* there too; whether the QuickPick's own seeded
  *text* is separately selectable from inside the picker UI itself is unverified (#218) — VS
  Code's `QuickPick` has no `InputBox`-style `valueSelection`, so the seeded text is visible but
  not proven selectable the way an `<input>`'s select-on-focus would be. The same picker backs the
  VMAD add-property dialog's Object-typed value and every VMAD object-property cell in the grid
  (`VmadObjectCell`, composing this same `FormKeyCell`). The link affordance appears on `Ctrl`-hover only when the
  reference resolves (rule 2 below); structs and arrays as a collapsed summary expandable to child rows,
  and are themselves drag sources for their whole value via that summary row, the same as a
  scalar leaf, collapsed or expanded alike (#204).
- **A declined write is always a refusal, never a silent no-op reported as success** (#532):
  a scalar or FormLink cell edit that the backend can't honor — a converter rejecting the typed
  value, an unparseable FormKey string, a property absent from the record's own concrete
  subclass — refuses naming the field, the same contract complex-field writes already had
  (#503/#531). A declined member inside an otherwise-valid struct/array write fails the whole
  write, not just that member; a member legitimately absent from a record's own subclass (the
  sparse leaf-union case, e.g. some OMOD property members) stays a silent no-op, since that's
  correct round-tripping, not a defect.
- **A `string` cell's right-click menu opens the extended editor** — **Open in Editor…**
  (#258/[ADR-0039](../adr/0039-no-left-click-leaves-the-record-panel.md); originally #230, ADR-0034
  divergence #2). xEdit's own answer for this surface is `TfrmViewElements`, a separate modeless
  window; a modeless Delphi form has no analogue worth reproducing in a webview (reproducing one
  would be exactly the chrome [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md)
  forbids), so the vehicle is substituted for a real **editor tab**, opened `ViewColumn.Beside` so
  the grid stays visible, non-preview so it isn't silently replaced by the next single-click
  preview elsewhere. xEdit's window also shows the value across every compared record; the grid
  already does that (one row, one column per plugin), so that half of `TfrmViewElements` isn't
  ported — the tab holds one plugin's value. That much is unchanged since #230; what changed is the
  *trigger*, per ADR-0039: xEdit's own gesture for this (`EditTips`: *"Double click on text fields
  in the right pane to open multiline editor"*) opens its modeless form **over** the grid, leaving
  the tree and the user's place untouched — but the substituted vehicle is a VS Code tab, which
  **relocates** the user (the record panel loses focus, the active editor changes), an interaction
  xEdit itself never has. No amount of left-clicking may cost the user their place in the panel, so
  the trigger is now right-click only, on mutable and immutable columns alike — a native
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
    whole-field reconstruction inline edits use (#503), not a bare value under the subtree root's
    path — the trigger carries the row's own path and the subtree root's field alongside the saved
    text (#533). A top-level string field's commit is unaffected — the same value either way.
  - **Trigger gesture**: right-click only (#258/ADR-0039). Before this, every `string` cell's
    second click and `F2` opened the inline editor while its double click opened this tab instead —
    the one type/gesture pair where second-click/F2's target and double-click's target genuinely
    differed — which meant the second click's own "open inline" action had to run behind a short
    debounce so a following native `dblclick` could still cancel it and redirect here. That debounce
    (and the dblclick redirect itself) is gone: a `string` cell's second click, `F2` and double click
    now all agree with every other scalar type on the inline editor, immediately, with no
    disambiguation needed, because there is no longer a second left-click target to disambiguate
    against.
  - **Scope**: every plugin column (`ScalarCell`/`DiffRow`). A plain `string`-typed row reaches the
    extended editor regardless of whether it's an ordinary field or a VMAD property (#231 folds
    both onto the same `ScalarCell`). A composite leaf's own inner string widget (a condition
    parameter's Text category, `conditionParam`) doesn't yet — its outer `FieldMetadata.type` isn't
    `'string'`, which is what this menu entry keys on (#231's own noted gap). A `string` cell that
    doesn't reach it keeps its inline editor on every left-click gesture, unchanged.
- **Unsorted array fields have arity and order operations** — **Move Up** / **Move Down** (swap
  with the neighbour) and **Remove** on an element row, and **Add** on the parent array row,
  appending a default-valued element (#142). They live in the **right-click menu**, with
  `Ctrl+↑` / `Ctrl+↓` / `Delete` / `Insert` as accelerators onto the same menu items — xEdit's
  arrangement exactly, and required by the no-second-route rule: **there are no inline ▲▼✕
  buttons.** (They shipped as inline buttons in #142, before ADR-0034; #227 converted them —
  a native `webview/context` menu on the element/parent cell, `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓`
  as DOM keydown accelerators on the focused cell, no extension-host round trip needed for the
  keys since `onArrayEdit`/`onArrayAdd` are pure in-webview state.) Add is available regardless of
  the array's expand state, matching xEdit — the retired "+" button's expanded-only visibility was
  that button's own rendering choice, not a functional rule. Sorted (`wbArrayS`) arrays offer none of these — order is derived from the
  sort key, so the entries are absent, not merely disabled. All three ops write the **whole
  array** as a single field edit — the atomic complex-field write CONTEXT.md describes — and only
  on non-immutable columns. An element-**value** edit is offered on the same cell and shares this
  same reconstruction: the whole array (or struct-array element) is rebuilt before the write, so
  it lands atomically rather than being silently lost (#503). The context-menu ops' wire payload
  carries the element's full `path` + `rootField` (#533's addressing contract), so ops on an
  array nested inside a struct or another array land at the element's real depth, and Add
  resolves its default element from the nested array's own element type via `metaAtPath` — the
  pre-#535 payload carried only a bare element index, which truncated both. There is no free
  drag-reorder and no auto-sort. A VMAD array-of-scalars
  property reuses this exact same machinery with no VMAD-specific code (#231); VMAD's struct/
  structList element ops and Conditions' own add/remove/reorder are described under *VMAD and
  Conditions are ordinary rows in the one tree* below.
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

### Progressive load ([#308](https://github.com/WhiskyTangoFawks/ModBench/issues/308), [ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md))

A plugin's records are browsable — and therefore this panel is openable — the moment that plugin
is indexed, well before the winner sweep runs ([#307](https://github.com/WhiskyTangoFawks/ModBench/issues/307)
gave the Plugins tree this same fact). Unlike the tree, this panel *does* render conflict
colouring today, which makes it the one surface where **an absent conflict badge is indistinguishable
from "no conflict"** actively misleads rather than merely omits.

- **A record opened while the sweep is outstanding carries an explicit statement** that the
  comparison is incomplete and the colouring rendered from it is not final
  (`recordPanelIncompleteMessage`, `medit/sessionProgress.ts`) — an in-panel banner, the compare
  grid's own equivalent of the tree's `TreeView.message` (a `WebviewPanel` has no such native
  surface). It clears itself, no user action, once the sweep lands.
- **Gate on `SessionStatus.conflictsComputed`, never on "is a load running"** — same rule
  `plugins.md`'s own Progressive load section states, for the same reason: the sweep is whole-set,
  so a live mutation can leave a *Ready* session with stale winners this panel must still caveat.
- **A panel already open when the sweep lands refetches its comparison**, not just clears its own
  banner over stale content — the extension host broadcasts `SESSION_CONFLICTS_COMPUTED` to every
  open record panel exactly once, from `SessionController.reportLoadedSession`, the one point a
  `loadExplicitSession` call is known to have completed the sweep. No poller: the tick stream
  `plugins.md`'s own progress indicator polls (`GET /session/status`) stops at essentially the same
  instant the backend sets `conflictsComputed`, so it cannot reliably observe the transition —
  reusing the load's own completion is the reliable choke point instead.
- **Forward coupling ([#97](https://github.com/WhiskyTangoFawks/ModBench/issues/97)):** the
  broadcast above fires only on the load-completing false→true transition. `conflictsComputed` is
  a separate field from session state precisely because live mutation (reorder, enable, disable)
  will re-sweep a *Ready* session and can leave it stale again — true→false, the opposite
  direction — and nothing described here observes that. Live mutation owes this panel the same
  notification on the way *out* of settled, or the banner silently stops working the moment that
  ships.

### Conflict color coding

The compare grid uses the two-axis model from
[ADR-0016](../adr/0016-two-axis-conflict-model.md). These two mappings are kept as tables
deliberately — they are enum→visual encodings that prose would only make less precise.

**Axis 1 — ConflictAll → row background.** `ConflictAll` is computed at two independent scopes
(#114, [ADR-0016](../adr/0016-two-axis-conflict-model.md)'s 2026-08-11 update) — this table's
colors apply at both, only the *granularity of computation* differs:

- **Record-wide** (one value per record, `CompareResult.ConflictAll`): drives the
  [Plugins tree](plugins.md)'s per-record conflict badge only — "the record's override
  stack as a whole."
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
background color" for "something here actually needs attention" is the signal #114's original
report found muddied by the pre-#114 record-wide smear.

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

The [Plugins tree](plugins.md)'s record-node conflict badge ([#364](https://github.com/WhiskyTangoFawks/ModBench/issues/364))
is driven by the same classification, at the record-wide scope specifically (Axis 1 above) —
never the per-node scope the compare grid's own rows use. It renders on the
[Conflicts node](plugins.md#conflicts-node-and-conflict-badge-364)'s own rows only (not on every
ordinary record row wherever a plugin is browsed — a deliberate scope decision, see the Plugins
tree spec), sharing `RecordDecorationProvider`'s existing M/A working-tree badge (#428) rather
than a second provider: a row has exactly one `FileDecoration`, so the two are reconciled by
precedence, not painted independently.

**Plugins-tree badge — `ConflictAll` → glyph, colour, precedence:**

| ConflictAll | Badge | Colour (`ThemeColor`) | Tooltip |
| --- | --- | --- | --- |
| OnlyOne, NoConflict | *(none)* | — | *(no badge)* |
| Override | `O` | `gitDecoration.addedResourceForeground` (green — reused from the `A` badge, never shown on the same row) | Override |
| Conflict | `C` | `gitDecoration.conflictingResourceForeground` (VS Code's own semantic "conflict" token) | Conflict |
| ConflictCritical | `!` | `problemsErrorIcon.foreground` (reused from the master-issue/load-failure row decorations) | Conflict (critical) |

No new colours: every token above is already sanctioned elsewhere in this codebase, matching this
section's own Axis 1/Axis 2 tables' "no new colors" rule (ADR-0016's 2026-08-11 update).

**Precedence: the M/A working-tree badge always wins when present.** An uncommitted local edit
(`Modified`/`Added`) is the more actionable, session-local fact, so it takes the row's one
`FileDecoration` slot; the conflict badge above shows only when the working-tree state lookup has
nothing to say (`None`) for that row. Orchestrator-approved default at #364's plan gate — not
dictated by ADR-0016, disclosed as a choice rather than buried.

**Gated on `SessionStatus.conflictsComputed`, per #307's invariant** (`PluginTreeProvider
.conflictAllOf`): renders nothing at all — never a neutral/placeholder badge — while conflicts
are not yet computed, or for a record nothing has fetched a conflict state for yet. An absent
badge must never be mistaken for "no conflict".

### Partial Form overrides (#491)

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
  never-hide-data posture — but visually marks it: the same `DIMMED_OPACITY` treatment a
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
  flag, which restores full editability — is its own write surface (**#539**, below).
- **Header write path clears the flag, restoring full editability (#539).** A synthetic field
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
  from creation — #440) and a lightbulb offering it on an identical-to-master container (a
  separate ticket under #478).

### VMAD and Conditions are ordinary rows in the one tree

VMAD (Papyrus script data) and Conditions (CTDA) are not a separate section, table body, row
renderer, or cell renderer — they are ordinary rows in the same compare tree every other field
uses (#231). Two pure frontend adapters, `vmadTreeAdapter.ts`/`conditionTreeAdapter.ts`, map the
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
excludes both condition-shaped properties (#178) and the virtual-machine-adapter property (#260)
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

**Synthesized metadata, the pattern the Condition section already proved (#228/#229) applied more
broadly:** five leaf types exist only in synthesized `FieldMetadata` (`vmadObject`,
`conditionFunction`, `conditionRunOn`, `conditionComparison`, `conditionParam`) — the backend never
emits them. Each is a genuine exception to the plain type→widget mapping, the same way `formKey`
already is: a VMAD object property is a `(FormKey, alias)` pair (composes the shared `FormKeyCell`
plus an alias input, #229's `VmadObjectEditor`, unchanged); a condition's Function opens a
QuickPick over the function catalogue, never a text/dropdown editor; Run On, Comparison, and a
parameter each pick their own widget from their own current value's shape (a `{target,
reference}` pair; a plain number vs. a GLOB FormKey string, distinguished by JS type rather than a
sibling Use-Global flag this row has no access to; a `{category, …}` tagged union) rather than a
second per-plugin metadata branch `DiffRow` would otherwise need. Run On's own target enum is
likewise a server catalog (#167: `GET /condition-run-on-targets`, `RecordSessionClient
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
Add/Remove/Move Up/Move Down, `Insert`/`Delete`/`Ctrl+↑`/`Ctrl+↓`) applies to a VMAD array with
*zero* VMAD-specific code anywhere in `DiffRow`/`RecordPanel`; **struct**/**structList**
(ArrayOfStruct) use `commitOverride` as described above, with structList's own instances exposed
as array elements the same way (Remove/Move reuse the generic array machinery unmodified; instance
**Add** is the one case still pending a follow-up, noted below). A **variable**-kind property is
`readOnly` — it was never editable under the pre-#231 model either.

**Conditions' shape**: one **`type: 'array'`** row per condition-owning field (not a struct
container the way VMAD's script list is) — a condition list's add/remove/move already wrote
the whole list at one field path before this work, the identical shape an ordinary unsorted array
writes in, so it reuses the **same** array-op machinery Conditions' AC asks for
("consistent with array operations") with **zero new commands**. Conditions align across plugins
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
silently persist. The function picker is still the native QuickPick described previously (#211),
listing `GET /condition-functions`'s server-filtered catalogue.

**Structural ops are right-click-menu commands**, consistent with every other structural op in
this grid (ADR-0034's no-second-route rule) — **Add Script**, **Remove Script**, **Add Property**,
**Remove Property**, **Set Script Flags**, and **Set Property Flags** are native `webview/context`
menu entries on the "Scripts (VMAD)" wrapper row, a script row, or a property row respectively
(`vmadScripts`/`vmadScript`/`vmadProperty` sections, the same broadcast-and-self-filter shape as
#227's array-op commands — the extension host has no live reference into the webview's React
state, so each command broadcasts to every open panel and each self-filters on `formKey`). A row's
`data-vscode-context` is not one exclusive slot: `combineVscodeContexts` (`recordUtils.ts`) merges
every context object sharing a row into one space-separated `webviewSection` token string, and
`package.json`'s own `when` clauses match their own token with `=~ /\btoken\b/` rather than `==`
— so a VMAD **array-of-scalars property**, which is simultaneously an array-op target
(`arrayParent`/`arrayElement`) and a VMAD structural-op target (`vmadProperty`), offers both
menus from the same cell, not whichever context happened to be built last. Set Script Flags seeds
its QuickPick with the script's own current flags (moved to front of the choice list, no
`activeItem` — the same "no default selection" convention the condition-function picker already
uses); Set Property Flags has none, matching property flags' own pre-#231 set-only behaviour (a
property's current flags were never surfaced for reading, only ever defaulted to `'Edited'` by Add
Property). Add Script's own name collection is still the native input box (#212,
`vscode.window.showInputBox`, now called directly by the command instead of round-tripping through
the webview first); Add Property is still the one deliberate webview-rendered dialog
(`ModalShell`/`AddPropertyDialog`, #229's own exception — three fields at once, a multi-step
QuickPick chain would be worse UX) — the command only tells the webview which script/plugin to
open it for. Condition add/remove/reorder need no new commands at all (above). Each
condition-owning field is still keyed and written independently by its own field path
(`ConditionOwner.FieldPath`/`ConditionGroupDiff.FieldPath`, `Fallout4ConditionCodec.Extract`
reflecting over every top-level property shaped like a condition list — #154), and a
condition-owning field still renders **only** as a condition row, never also as a raw generic
field (`SchemaReflector` excludes it from the generic reflection pass, #178).

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
Open in Editor…, #258/ADR-0039) reaches every plain `string`-typed row (including VMAD's own plain
String properties) but not yet a composite-typed leaf's own inner string widget (a condition
parameter's Text category) — its outer `FieldMetadata.type` isn't `'string'`, which is what that
menu entry keys on.

Condition lists nested one array level below the record (e.g. a magic Effect's own
`Effects[i].Conditions` on Ingestible/Ingredient/Spell/ObjectEffect, a Message's
`MenuButtons[i].Conditions`) are discovered by the same shape test applied to each array element,
keyed by an indexed field path composing the enclosing array's own name and index with the nested
list's own name (e.g. `Effects[2].Conditions`) — the existing `CTDA\<field path>\<index>\<subField>`
wire path treats that whole composed string as one opaque field path, so no DDL or wire-shape
change was needed (#181). A path through a **Child record** (a record type Mutagen enumerates as
its own top-level row, e.g. Quest's `Scenes`/`DialogTopics`) is excluded, since that record already
surfaces its own conditions through its own top-level field. Nested groups align across plugins
positionally by the enclosing array's index and sort by that index numerically, not
lexicographically. Pre-#231, a nested group defaulted collapsed while a flat top-level group
rendered fully open, a bespoke per-group default; post-#231 every condition-owning field's row is
an ordinary array row and defaults collapsed uniformly (rule 3 above), nested and flat alike — a
small, deliberate simplification folding a special case into the one rule every other array/struct
already follows, rather than preserving it as a second default only conditions had. Read-only for
now, on both ends: the frontend renders a nested group's rows display-only (no
function/parameter/operator inputs, no add/move/remove controls), and `PluginWriter.IsReadOnly`
rejects a nested (indexed) condition path at edit time as a second, independent gate. Editing at a
nested path stays rejected until scalar editing lands (#182), add/remove/reorder inside
a nested list until #183, and two levels of nesting (a Perk effect's own conditions, a Quest
alias's/stage's own conditions) until #184.

Codec support is FO4-only today, reflecting Mutagen's four structurally different per-game
condition data shapes (no shared cross-game interface, unlike VMAD's `IHaveVirtualMachineAdapter`)
— a per-game `IConditionCodec` strategy resolved by `GameCategory` (ADR-0032); other games are
tracked separately (#164). FormKey-typed condition parameters, the Run On reference, and a
Use-Global comparison target each resolve through the same backend signal VMAD uses (#166) — link
label and affordance follow the real resolution, not a raw FormKey — and each is fed into
`form_references` (#166), so a record referenced only by a condition now surfaces in Referenced By.

### Field type rendering rules

These apply everywhere a field value is rendered — the one compare grid and any future surface,
VMAD/Condition rows included (#231) since they render through this exact code now:

1. **Never display raw integers for enums or flags** — always resolve to name(s).
2. **FormKeys render as links**, labelled `EditorID [FormKey]` when the reference resolves and the
   bare FormKey when it doesn't — the same composite the picker's own items have always used, so
   the format a reference is *chosen* in and the format it is *read back* in are identical.
   Labelling with the EditorID alone (as #157 shipped) is superseded: a FormKey is the identity and
   the EditorID is decoration, and a cell that does not display its own identity cannot hand it to
   the user by any mechanism. Where
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

   A VMAD object property (`vmadObject`, `VmadObjectCell`) sources the same signal from
   `VmadPropertyDiff.resolutions` (#158) — its link label and affordance follow the real
   resolution, not a well-formedness proxy, so a dangling reference (one pointing outside the
   index) no longer looks followable.
3. **Structs and arrays are always collapsible**, default collapsed; expand state is
   per-session, not persisted across restarts. Array **element values** offer the inline-edit
   gesture everywhere (plain and struct-element arrays alike); committing one reconstructs the
   array's (or struct-array element's) whole value before the write, per the reconstruction
   CONTEXT.md's Complex-field entry's atomic-write model requires for a per-element gesture
   (#503). Array **arity and order** are editable for **unsorted** arrays (add / remove /
   move-up / move-down, swap-based, on non-immutable columns) and **absent** for sorted
   (`wbArrayS`) arrays, whose order is sort-key-derived (#142) — these ops use the same
   whole-array reconstruction. A VMAD array-of-scalars property reuses this exact machinery
   (#231); VMAD's own struct/structList element ops are described under *VMAD and Conditions
   are ordinary rows in the one tree* above. A list whose element's concrete type is
   polymorphic (OMOD `properties`' `AObjectModProperty<T>`, seven concrete leaves) resolves
   each element's own type from a `value_type` discriminator sub-field at write time; an
   element whose discriminator is missing or unrecognized refuses naming the field, rather
   than guessing or crashing (#531; #360 landed the same polymorphism read-side).
4. **A cell always renders Effective state** — committed text with any uncommitted working-tree
   change already overlaid (#413); there is no separate pending/dirty visual treatment on this
   panel. Revert is a git gesture in the native Source Control panel, not a cell-level control
   here ([medit-version-control.md](medit-version-control.md)).
5. **Null / missing fields** render as an empty cell, never "null"/"undefined".
6. **Read-only cells** in immutable plugin columns are never editable and render no input on
   click.
7. **A signature backed by several concrete Mutagen subclasses that declare the same list/struct
   field with genuinely conflicting element shapes** gets one of two treatments, both replacing
   "one column silently reads null for every subclass but the schema's discovery winner" (#339):
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

   Both differ from the *identical*-shape case (#263), where a member declared on a shared ancestor
   already reads correctly off every sibling and needs no special handling at all. `FieldMetadata`
   itself stays column-wide in every case — there is no per-row element shape.

### Action logging

Editor interactions emit a leveled line on the **Modbench** output channel (#198), so the
channel's native level filter controls volume. The webview has no channel of its own: it posts a
`LOG` message over the existing webview→extension-host bridge and the router dispatches it to the
channel at the carried level (#200).

- **DEBUG** — the field-edit family: a committed disk-cell edit (VMAD/Condition leaves included,
  #231 — the same `handleEdit`/`handleVmadStructOp` call sites, not a separate log site per
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
  record panel, and command registration holds — add any new command id(s) to
  `EXPECTED_COMMANDS`.

## Out of Scope

- **Multiple simultaneous record editor panels** — one panel is open at a time and reused when
  navigating (an extension invariant).
- **Editing Papyrus source** — VMAD's own rows edit script *data* (properties, their values
  and types, script and property flags). Compiling or editing `.psc` source is a different job
  and is not this surface's.
- **Save and revert on this panel** — writing the binary is the separate Save & Compile gesture;
  reviewing and reverting a working-tree change happens in the native Source Control panel — both
  [medit-version-control.md](medit-version-control.md).
- **Referenced By** — a separate tree, [medit-referenced-by.md](medit-referenced-by.md).
- **Array arity/order editing of *sorted* (`wbArrayS`) arrays** — deliberately absent: order is
  derived from the sort key, so add/remove/reorder controls do not render on them. Unsorted
  (`wbArray`) arrays gained field-grid arity/order controls in #142 (arity changes write the
  whole array as one field edit).

## Further Notes

- The rationale for removing edit mode (xEdit's `toEditOnClick` parity, and the fact that column
  immutability already prevents accidental writes) is recorded in #111.
- #111 also established that editability is per **column**, replacing a mode: before it, the
  cells were never told which columns were immutable, so a read-only column rendered inputs
  the backend then rejected with a 409.
- **Open question: does `Ctrl+click`-to-follow survive alongside a right-click "Go to Record"?**
  [ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)'s gesture table lists
  `Ctrl+click` without resolving this. The tension: it's undiscoverable (no visible
  UI element hints at it) but is also shipped, xEdit-familiar muscle memory: removing it costs
  existing users a gesture they already rely on; keeping it alongside a menu item means two ways
  to do the same thing, the exact redundancy this ADR otherwise rules out everywhere else in this
  surface. Unresolved until decided explicitly.
