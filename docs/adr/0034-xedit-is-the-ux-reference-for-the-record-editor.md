---
status: accepted
---

# xEdit is the UX reference: click focuses, the keyboard acts, double click edits

## Context

The record editor's gestures were first specified from memory of xEdit rather than from xEdit,
anchored on **left-click = edit** (see Alternatives rejected). That one choice left no gesture
for selection, forced copy to come from native text selection, collided with drag consuming the
mousedown, and produced the absurd result that a read-only column could hand you its value and
an editable one could not.

[The xEdit UX audit](../research/xedit-ux-audit.md) shows xEdit has none of these problems,
because it never puts anything on a single click: `vstViewClick` exits unless Ctrl is held, so
plain click is left to the tree's own focus machinery. Click means *focus*. Editing is reached by
F2, by a second click on an already-focused cell, or by double click. The clipboard is a keyboard
operation on the focused cell's **model value** (`Element.EditValue`), so it does not care what
widget the cell renders. [ADR-0019](0019-xedit-unified-tree-model-for-compare-grid.md) had
already established the principle for the compare grid's *data* model; it governs the
*interaction* model too.

## Decision

**xEdit is the UX reference for this surface.** Where xEdit has an answer, mEdit adopts it. The
only admissible reason to diverge is a genuine platform limitation that cannot be worked around —
not that an alternative seems nicer, cleaner, or more modern. xEdit has 25 years of refinement
against this exact problem domain, and essentially every mEdit user arrives already fluent in it;
familiarity is worth more than local improvement.

### Baseline, not ceiling

The rule governs **replacing** xEdit's answers, not **adding** what xEdit never had. An opt-in
power-user addition with no xEdit counterpart needs no platform-limitation justification,
provided the default experience remains xEdit's (the addition is reached by an explicit, opt-in
affordance, never a changed default), no existing xEdit gesture or meaning is redefined to reach
or operate it, and where the addition overlaps ground xEdit does cover, xEdit's vocabulary and
semantics carry into it. First instance: the transposed record view, an optional
plugins-as-rows orientation on top of the default plugins-as-columns grid.

### The gesture model

| Gesture | Meaning |
| --- | --- |
| **Single click**, value cell | Focus that cell. The row highlights; one cell carries focus. Nothing else happens. |
| **Single click**, already-focused cell | Open its inline editor. |
| **Double click**, value cell | Open the inline editor. No left-click gesture reaches the extended editor ([ADR-0039](0039-no-left-click-leaves-the-record-panel.md)). |
| **Double click**, label column | Expand/collapse the node. |
| **Ctrl+click** | Follow the reference to its record. |
| **Click and hold, drag** | Copy this value into wherever it is dropped. Not advertised by the cursor. |
| **Right-click** | Named, discrete actions, including list structure ops and the extended editor. |

### The keyboard, acting on the focused cell

`F2` edit · `Ctrl+C` copy · `Ctrl+X` cut · `Ctrl+V` paste · `Insert` add list entry · `Delete`
remove entry or clear value · `Ctrl+↑`/`Ctrl+↓` reorder within an unsorted list.

**Clipboard operations carry the cell's model value, not DOM text.** This is the load-bearing
change: copy stops caring whether the cell renders a text box, a dropdown, a checkbox or a link,
so every type is copyable in every column, and the mutable/immutable inversion disappears.

### Selection and the resting cursor

Single-select, matching xEdit: the row highlights, one cell within it carries focus, and the
focused cell is what every keyboard action operates on. No multi-cell ranges. The resting cursor
is the default arrow; drag is not advertised, exactly as in xEdit.

## Permitted divergences, and why each is forced

1. **FormKey editing uses a native QuickPick**, not xEdit's sorted combo box. The webview cannot
   host a searchable 1000-row picker as well as VS Code already does, and
   [ADR-0027](0027-mo2-surfaces-map-to-native-vscode-views.md) requires the native surface where
   one exists. Behaviour aligned (type to search, pick to commit); vehicle substituted.
2. **The extended editor is a VS Code surface**, not a modeless form. xEdit's `TfrmViewElements`
   has no analogue we can or should reproduce in a webview; the native answer is an editor tab.
   Because a tab relocates the user in a way xEdit's modeless form never did, no left-click
   gesture reaches it — it is a right-click action, on immutable cells (read-only) as well as
   mutable ones ([ADR-0039](0039-no-left-click-leaves-the-record-panel.md)).
3. **The clipboard is written through the extension host** (`vscode.env.clipboard`) rather than
   from the webview. A mechanism detail with no user-visible difference, chosen because webview
   clipboard access is not guaranteed.
4. **Tracking, compile and branch UX follows git and VS Code, not xEdit.** xEdit writes to the
   in-memory plugin and saves; Modbench edits a tracked mod's source in a git working tree and
   compiles it ([ADR-0041](0041-manual-git-tracking-compile-from-text.md)). xEdit has no model
   for review, revert or history, so the references there are git's own and VS Code's native
   Source Control idioms. A product difference, not a UX one, and out of this ADR's scope.
5. **Record creation always prompts for an EditorID**, on both "Add" and "Copy as New Record" —
   not xEdit's own split behavior (silent default on Add, prompted-and-skippable on Copy as New,
   `xeMainForm.pas` `mniNavAddClick` vs. `CopyInto`'s wrapped-copy path). Maintainer
   ruling: a deliberate divergence, not a platform-limitation one — Add's *default*
   changes, which "Baseline, not ceiling" above would otherwise forbid without an opt-in
   affordance. Recorded here rather than silently overridden.
6. **NPC template-sourced fields are gated, not freely editable.** xEdit gates editability only
   on internal-edit flags — template flags never affect it (`TwbElement.GetIsEditable` /
   `TwbMainRecord.GetIsEditable`, `Core/wbImplementation.pas`; template flags carry only a
   visibility callback, `wbTemplateActorDontShow`). mEdit instead treats fields covered by an
   active template flag as not editable until that flag is cleared, warning when clearing a flag
   whose covered fields conflict with the template. Maintainer ruling: a
   correctness divergence, not preference — with the flag set, the engine sources those fields
   from the template, so xEdit's permissiveness lets the user edit data the game demonstrably
   ignores. Where xEdit's answer is demonstrably wrong about the domain, it is not a reference.
7. **A flags row expands into an in-cell checkbox list**, one flag per line, collapsed by
   default to xEdit's own compact name summary. xEdit's edit gesture opens a transient
   `etCheckComboBox` instead; here the expanded state is a persistent render toggled by the
   grid's chevron/double-click gesture, and toggling a checkbox commits directly. Maintainer
   ruling (2026-09-01 live session): a deliberate divergence — the collapsed default keeps
   xEdit's at-rest look, but expansion replaces its editor rather than reproducing it.
   Recorded here rather than silently overridden.

Anything not on this list aligns.

## Consequences

- An immutable cell simply refuses to edit, as in xEdit; there is no read-only "selection surface".
- Single-click activation does not exist on any cell type; `cursor: grab` does not exist on any
  value cell.
- Inline array controls (▲▼✕) live in the right-click menu and on the keyboard. An action
  reachable by right-click is never also reachable a second, redundant way.
- Cell focus is state that lives in the grid, above any leaf.
- The gesture matrix in the record-editor spec derives from this: with copy on the model value,
  availability stops varying by type and column kind.
- Select-on-focus in the editor and the placeholder rule for `{…}`/`[3]`/`—` stand.

## Applies beyond this surface

The rule — **consult xEdit before designing any record-editing interaction, and diverge only
under a platform limitation** — governs the record editor, VMAD and Condition sections, and any
future plugin-editing surface. Divergences taken under that wider rule are recorded as their own
ADRs, so they stay findable: [ADR-0037](0037-unresolvable-masters-are-indexed-and-flagged.md) (a
plugin with unresolvable masters is indexed and flagged rather than force-deactivated, justified
by Mutagen's self-describing FormKeys against xEdit's whole-graph resolution) and
[ADR-0038](0038-masters-are-lifecycle-derived-never-user-declared.md) (masters are derived from
content and never user-declared, justified by Mutagen rebuilding the master list from the live
object graph on every save against xEdit's in-place byte patching). It does not govern Mod
Management, which has no xEdit counterpart and takes its cues from MO2 instead
([ADR-0027](0027-mo2-surfaces-map-to-native-vscode-views.md)).

## Alternatives rejected

- **Left-click = edit, "one gesture, one meaning".** Three gestures
  with one meaning each — left-click activates the cell's text surface (an editor on a mutable
  column, read-only on an immutable one), drag copies a value, right-click holds named actions —
  plus a cursor contract (`grab` at rest, caret when clicked) so copy and paste could be the
  platform's own text selection with no clipboard code. The goal stands; the anchor was wrong.
  With edit on single click there was nothing left for selection, so a read-only surface had to
  exist just to have something to select from; `draggable` consumed the mousedown that would
  start a selection; bounded-list types (`bool`/`enum`/`flags`/`formKey`) activated controls,
  not text, so they were copyable only in immutable columns; and one cursor could not honestly
  advertise both drag and click-to-activate. Every problem was downstream of the first choice,
  and every one is absent in xEdit. What survived: an action reachable by right-click is never
  also reachable a second way; a cell's displayed text must be its value (the FormKey label is
  `EditorID [FormKey]`, matching its picker).
