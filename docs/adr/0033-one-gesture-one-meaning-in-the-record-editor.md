---
status: accepted
---

# One gesture, one meaning, everywhere a value lives in the record editor

Each record-editor interaction shipped independently over several phases (#3, #111, #140, #142,
#176, #177…), and each one made its own local call about which gesture triggers it. That produced
three concrete inconsistencies, all found by inspection rather than by design: a mutable cell's
resting cursor shows a text-caret (from `ScalarCell`'s inactive-state span) that visually masks
the `grab` cursor `DiskCell` sets underneath — so the cursor implies only editing is possible, but
the cell is still a drag source the whole time. Compound (struct/array) rows never got wired for
drag at all — only scalar leaves did, when #3 shipped. And reverting a pending change is reachable
two ways at once (an inline ↩ button, and Revert Group in the pending cell's own right-click menu)
once the latter existed. None of these are bugs in the usual sense — every gesture works as its
own feature intended. They're evidence that the surface has no single rule for "what does this
gesture mean," so each new feature is one more independent guess.

## Decision

Three gestures, one meaning each, enforced uniformly across the compare grid, VMAD, and Condition
sections alike — no exceptions per cell kind:

- **Left-click** — activate this cell's text surface. On a mutable column that surface is an
  editor; on an immutable column it is the same surface, read-only. Nothing else, ever.
  (Amended — see "Amendment: the cursor contract" below. As originally written this read "edit in
  place… a cell that cannot be edited shows no click affordance for it at all.")
- **Click-and-hold, drag, drop** — copy this value's content directly into wherever it's dropped.
  Available from any cell regardless of the *source* column's mutability (only the drop target's
  mutability gates the drop); applies to compound (struct/array) fields via their header/summary
  row exactly as it applies to scalar leaves — there is no cell kind that silently opts out.
- **Right-click** — the only place a named, discrete action lives: Reveal in Pending Changes Tree /
  Save Group / Revert Group on a pending cell, Copy as Override / Copy as New / Remove on a column
  header. An action reachable through right-click is never *also* reachable through a second,
  redundant control (e.g. no standalone revert icon once Revert Group exists in the menu).
  Getting a *value* out of a cell is **not** one of these actions — see the amendment below.

**Ctrl+click is acknowledged as a fourth, navigation-only gesture** (follow a FormKey reference to
its record) for now, without resolving whether it survives once a right-click "Go to Record"
exists — that's a separate, still-open decision (see the record-editor surface spec).

## Consequences

A cell's resting affordance must reflect every gesture actually available on it, not just the one
its leaf renderer cares about — concretely, `ScalarCell`'s inactive state must stop asserting its
own cursor and let the drag-capable parent's cursor show through until the cell is actually
clicked into edit. Any new field kind or action added to this surface picks its gesture from this
list rather than inventing one; if none of the three fit, that's a signal to revisit this decision
explicitly rather than add a fourth ad hoc gesture.

## Amendment: the cursor contract

The original decision left one gesture unassigned: **getting a value out of a cell as text.** That
gap surfaced while designing field copy/paste (#201), and closing it required amending the
left-click rule above.

The mouse cursor is a promise. `grab` means "this is an object you pick up"; a caret means "this is
text you select." A surface cannot honestly make both promises at once. Because left-click meant
*edit* and an immutable cell had no click affordance, an immutable cell was a permanent drag source
showing `grab` forever — and `userSelect: 'text'` on it was dead letter, since `draggable`
consumes the mousedown that would start a selection. The result: no way to read a value out of any
immutable cell, and no way out of a flag, enum, bool or FormKey cell in *any* column, because none
of those render a text surface when active either.

The instinct was to add a right-click **Copy** command per the "get text out → a Copy command"
rule. That rule is correct for trees and lists (Explorer, Problems, SCM, Debug Variables have no
text selection at all) and wrong here: a webview *does* have native text selection, so a Copy
command would be reinventing a platform mechanism, and it would leave a value cell that you cannot
read from without knowing a menu exists.

**Decision:** one rule governs every value-bearing cell, in both column kinds:

- **At rest** the cell shows `grab`. It is a drag source and nothing else. No text is selectable.
- **Clicked**, it activates a text surface and the cursor becomes a caret. Selection, `Ctrl+C` and
  `Ctrl+V` behave exactly as they do in any other text field, natively, with no extension code.
  On a mutable column that surface commits on blur; on an immutable column it is read-only and
  commits nothing. That is the *only* difference between the two column kinds.

  **Except for values chosen from a bounded list.** On a *mutable* column `bool`, `enum` and
  `flags` activate a control — checkbox, `<select>`, checkbox group — and `formKey` activates the
  native QuickPick. A control is not a text surface, so there is nothing to select and no caret.
  Copy is therefore available on those four types in an **immutable** column only, where they
  activate the read-only surface like everything else. This is a limit, not a defect: left-click on
  a mutable cell is spent on the editor, and for a value chosen from a bounded list the editor is
  not text — the same reason those types take no paste. Closing it would need a second gesture on
  those cells and there is none free. Such a value is moved by drag, or read from the same field in
  an immutable column. The full availability table lives in
  `docs/specs/medit-record-editor.md` § Gesture matrix, derived from the drag/selection interlock
  rather than enumerated.

Consequences:

- **Copy needs no command, no menu contribution, and no clipboard code**, in either process. It is
  the platform's, reached by activating the surface that already had to exist.
- **Paste needs none either**, for the types that accept it — a focused input already takes
  `Ctrl+V`, and the value flows through the same coercion and commit path a typed value does.
- **Immutable cells gain a click affordance**, reversing this ADR's original "shows no click
  affordance for it at all." The read-only surface must look visibly inert — no input border or
  background — so it reads as "you may select this," not "you may edit this."
- **Struct and array summary rows are the one exception.** They render `{…}` and `[3]` —
  placeholders, not values — so there is no text to offer and activating a surface there would
  hand the user junk that looks like a successful copy. They stay pure drag sources, cursor `grab`,
  no click affordance. Their leaves are reachable by expanding the row, and each leaf is an
  ordinary cell under the rule above.
- **A cell's displayed text must be its value.** A cell that renders a lossy label cannot hand its
  own value to the user by any mechanism, native or bespoke — which is why the FormKey label
  becomes `EditorID [FormKey]`, matching the format its own picker has always used, rather than the
  bare EditorID #157 shipped.
