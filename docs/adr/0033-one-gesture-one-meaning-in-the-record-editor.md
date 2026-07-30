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

- **Left-click** — edit in place. Nothing else, ever. Applies to disk cells and pending cells
  alike; a cell that cannot be edited (immutable column) shows no click affordance for it at all.
- **Click-and-hold, drag, drop** — copy this value's content directly into wherever it's dropped.
  Available from any cell regardless of the *source* column's mutability (only the drop target's
  mutability gates the drop); applies to compound (struct/array) fields via their header/summary
  row exactly as it applies to scalar leaves — there is no cell kind that silently opts out.
- **Right-click** — the only place a named, discrete action lives: Copy / Paste on a field, Reveal
  in Pending Changes Tree / Save Group / Revert Group on a pending cell, Copy as Override / Copy as
  New / Remove on a column header. An action reachable through right-click is never *also*
  reachable through a second, redundant control (e.g. no standalone revert icon once Revert Group
  exists in the menu).

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
