---
status: accepted
---

# xEdit is the UX reference: click focuses, the keyboard acts, double click edits

Supersedes [ADR-0033](0033-one-gesture-one-meaning-in-the-record-editor.md).

## Context

ADR-0033 set out to make the record editor's gestures consistent. It picked **left-click = edit** as
the anchor, then spent an amendment and a narrowing discovering that this leaves nothing for any
other gesture to mean:

- With edit on single click there is no gesture left for **selection**, so there was no concept of a
  focused cell at all.
- Copy therefore had to come from native text selection, which meant a cell had to *activate a text
  surface* before anything could be copied out of it.
- But every value cell is a drag source, and `draggable` consumes the mousedown that would begin a
  selection — so no resting cell could be selected from, which is what forced the read-only surface
  into existence (#201) just to have something to select.
- And a resting cell then had to advertise *both* drag and click-to-activate with one cursor, which
  is impossible; we shipped `grab` everywhere, which advertised the wrong one and hid the gesture
  users were actually hunting for.
- Two whole categories of cell ended up with no copy path at all (`bool`/`enum`/`flags` on a mutable
  column), producing the absurd result that a **read-only** column could hand you its value and an
  editable one could not.

Every one of those is downstream of the first choice. [The xEdit UX
audit](../research/xedit-ux-audit.md) shows xEdit has none of these problems, because it never puts
anything on a single click: `vstViewClick` exits unless Ctrl is held, so plain click is left to the
tree's own focus machinery. Click means *focus*. Editing is reached by F2, by a second click on an
already-focused cell, or by double click. The clipboard is a keyboard operation on the focused
cell's **model value** (`Element.EditValue`), so it does not care what widget the cell renders.

The deeper mistake was procedural: mEdit's interaction model was specified from memory of xEdit
rather than from xEdit. [ADR-0019](0019-xedit-unified-tree-model-for-compare-grid.md) had already
established the principle for the compare grid's *data* model — "xEdit (the reference tool that all
mEdit users will be familiar with)" — and it should have governed the *interaction* model too.

## Decision

**xEdit is the UX reference for this surface.** Where xEdit has an answer, mEdit adopts it. The only
admissible reason to diverge is a genuine platform limitation that cannot be worked around — not
that an alternative seems nicer, cleaner, or more modern. xEdit has 25 years of refinement against
this exact problem domain, and essentially every mEdit user arrives already fluent in it; familiarity
is worth more than local improvement.

### The gesture model

| Gesture | Meaning |
| --- | --- |
| **Single click**, value cell | Focus that cell. The row highlights; one cell carries focus. Nothing else happens. |
| **Single click**, already-focused cell | Open its inline editor. |
| **Double click**, value cell | Open the fullest editor the type has — inline for numeric and flag types, the extended editor otherwise. |
| **Double click**, label column | Expand/collapse the node. |
| **Ctrl+click** | Follow the reference to its record. Unchanged. |
| **Click and hold, drag** | Copy this value into wherever it is dropped. Unchanged, but **no longer advertised by the cursor**. |
| **Right-click** | Named, discrete actions, including list structure ops. |

### The keyboard, acting on the focused cell

`F2` edit · `Ctrl+C` copy · `Ctrl+X` cut · `Ctrl+V` paste · `Insert` add list entry · `Delete`
remove entry or clear value · `Ctrl+↑`/`Ctrl+↓` reorder within an unsorted list.

**Clipboard operations carry the cell's model value, not DOM text.** This is the load-bearing
change: copy stops caring whether the cell renders a text box, a dropdown, a checkbox or a link, so
every type is copyable in every column, and the mutable/immutable inversion disappears.

### Selection

Single-select, matching xEdit: the row highlights, one cell within it carries focus, and the focused
cell is what every keyboard action operates on. No multi-cell ranges.

### The resting cursor

Default arrow. Drag is not advertised, exactly as in xEdit — `grab` on every value cell is removed.

## Permitted divergences, and why each is forced

1. **FormKey editing uses a native QuickPick**, not xEdit's sorted combo box. The webview cannot
   host a searchable 1000-row picker as well as VS Code already does, and
   [ADR-0027](0027-mo2-surfaces-map-to-native-vscode-views.md) requires the native surface where one
   exists. Behaviour aligned (type to search, pick to commit); vehicle substituted.
2. **The extended editor is a VS Code surface**, not a modeless form. xEdit's `TfrmViewElements` has
   no analogue we can or should reproduce in a webview; the native answer is an editor tab or an
   input box. Behaviour aligned (double click reaches a fuller editor for text and reference types);
   vehicle substituted.
3. **The clipboard is written through the extension host** (`vscode.env.clipboard`) rather than from
   the webview. A mechanism detail with no user-visible difference, chosen because webview clipboard
   access is not guaranteed.
4. **The pending-change column and staged edits have no xEdit equivalent.** xEdit writes to the
   in-memory plugin directly. mEdit stages, per
   [ADR-0017](0017-pending-change-model.md)/[ADR-0028](0028-change-groups-are-derived-dependency-closures.md).
   That is a deliberate product difference, not a UX one, and it is out of this ADR's scope.

Anything not on this list aligns.

## Consequences

This invalidates work that has already shipped, and says so plainly rather than letting it rot:

- **`ReadOnlyValueSurface` is deleted.** It existed solely to give an immutable cell something to
  select; with `Ctrl+C` on the focused cell there is nothing for it to do. An immutable cell simply
  refuses to edit, as in xEdit.
- **Single-click activation is removed** from `ScalarCell`, `FlagCell`, `FormKeyCell`,
  `ConditionSection` and `VmadSection`.
- **`cursor: grab` is removed** from the value cells, and with it ADR-0033's cursor contract in full.
- **Inline array controls (▲▼✕) move to the right-click menu and the keyboard.** ADR-0033's rule
  that an action reachable by right-click is never also reachable a second way survives this ADR and
  applies here.
- **Cell focus is new state that lives above the leaf**, in the grid rather than in any cell — which
  is the same container [#219](https://github.com/WhiskyTangoFawks/ModBench/issues/219) exists to
  extract. Those two pieces of work are now one.
- **The gesture matrix in the record-editor spec is rewritten**, and most of its holes close: with
  copy on the model value, availability stops varying by type and column kind.

What survives from #201: select-on-focus in the editor, the placeholder rule for `{…}`/`[3]`/`—`,
and the three cursor-mask fixes (now moot, since no leaf asserts a cursor at all).

## Applies beyond this surface

The rule — **consult xEdit before designing any record-editing interaction, and diverge only under a
platform limitation** — governs the record editor, VMAD and Condition sections, and any future
plugin-editing surface. Divergences taken under that wider rule are recorded as their own ADRs, so
they stay findable: see
[ADR-0037](0037-unresolvable-masters-are-indexed-and-flagged.md) (a plugin with unresolvable masters
is indexed and flagged rather than force-deactivated, justified by Mutagen's self-describing
FormKeys against xEdit's whole-graph resolution). It does not govern Mod Management, which has no xEdit counterpart and takes
its cues from MO2 instead ([ADR-0027](0027-mo2-surfaces-map-to-native-vscode-views.md)).
