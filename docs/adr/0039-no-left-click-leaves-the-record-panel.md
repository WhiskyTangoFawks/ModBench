---
status: accepted
---

# No left click leaves the record panel

A recorded **behavioural** divergence from
[ADR-0034](0034-xedit-is-the-ux-reference-for-the-record-editor.md), taken under that ADR's own
rule that a divergence which is not a mere vehicle substitution must be recorded as its own ADR.

## Context

xEdit's `EditTips.txt` documents the gesture this ADR removes: *"Double click on text fields in the
right pane to open multiline editor."* ADR-0034 adopted it — its gesture table gives double click
"the fullest editor the type has", which for a `string` cell is the extended editor — and its
divergence #2 substituted the vehicle: xEdit's modeless `TfrmViewElements` form has no webview
analogue, so mEdit's extended editor is a VS Code editor tab.

The vehicle substitution changed what the gesture costs. xEdit's multiline editor opens *over* the
grid — the tree, the focused cell and the user's place all survive it. A VS Code tab **relocates**
the user: the record panel loses focus, the active editor changes, and getting back is its own
navigation. Adopting xEdit's gesture verbatim on the substituted vehicle produces an interaction
xEdit itself doesn't have: a plain left-click sequence that throws you out of the surface you were
working in.

It also carried a mechanical tax. `string` was the only scalar type whose second-click/`F2` target
(the inline editor) differed from its double-click target (the extended editor), so the inline
editor sat behind a debounce window purely so that a following `dblclick` could cancel it — every
inline string edit paid latency to disambiguate a gesture no other type needed disambiguated.

Maintainer ruling: **no amount of left-clicking should relocate the user to another panel.**
This is a place where xEdit's UX is bad and mEdit improves on it — deliberately, and recorded here
rather than applied silently.

## Decision

**No left-click gesture in the record editor moves the user out of the record panel.**

- A `string` cell behaves like every other scalar: second click, `F2` and double click all open the
  **inline** editor, immediately, with no debounce.
- The extended editor is reached only from the cell's **right-click menu** — a native
  `webview/context` contribution, the same mechanism the column-header and array menus use.
- The command is offered on **immutable** string cells too, opening the extended editor read-only —
  that path is the only way to read a long immutable value in full, and it survives.

What the extended editor *is* once open — tab, view column, temp-file mechanics — is unchanged;
divergence #2's vehicle substitution stands. Only the gesture that reaches it changes.

## Consequences

- The `string` branch's debounce constant, its timer, and its double-click-to-extended-editor
  binding are deleted; the branch collapses into the generic scalar branch.
- The record editor's right-click menus grow an extended-editor entry on string value cells,
  mutable and immutable.
- ADR-0034's gesture table (double-click row) and divergence #2 state this behaviour.
