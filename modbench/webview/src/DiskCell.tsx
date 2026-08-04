import React, { useLayoutEffect, useRef, useState } from 'react';
import { focusedCellStyle } from './gridStyles';

// A disk column's value cell. Issue #111: drag-to-copy is always on, but a draggable ancestor
// swallows text selection inside an input — the browser starts a drag instead of selecting — so
// the cell stops being draggable exactly while its own input is active.
//
// The cell learns that from focus events bubbling out of its own subtree rather than from the
// leaf renderers reporting it: which control a value renders as is the leaf's business (and
// there are several — text, number, select, checkbox, flag multi-select), while "does this cell
// currently contain an active input" is the cell's own. Watching its subtree keeps that
// knowledge on the right side of the boundary and costs the leaves no prop.
//
// Issue #221: extracted out of DiffRow.tsx (its sole caller until now) so it can be shared. The
// field-grid row is still the only caller today — VMAD and Condition sections hand-roll their
// own bare `<td>`s and pick this up in a later ticket.
//
// Issue #222 / ADR-0034: this is also where "is this the focused cell" becomes real DOM focus,
// not just painted state — `tabIndex` makes the cell itself a focusable element, and the effect
// below calls `.focus()` on it whenever it becomes (or re-becomes, after a re-render) the
// panel's focused cell. That is deliberate, not a convenience: #223 (second-click/F2 opens the
// editor) and #224 (Ctrl+C) both need `keydown` to land on a real focused element, so building
// real focus here means neither ticket has to redo this wiring.
//
// The effect must not fight an open editor: while a real `<input>`/`<select>`/`<textarea>` inside
// the cell has focus, it must not steal focus back to the `<td>`. It checks the DOM
// (`document.activeElement`) directly rather than trusting the `editing` state for that gate —
// `editing` flips true from the same input's own `onFocus` below, but layout effects across
// components can run before that state update is flushed, so a click that both focuses the cell
// (this effect) and opens its editor (the leaf's own onClick, autoFocusing an input) in the same
// commit could otherwise run this effect first, focus the `<td>`, and immediately blur — and
// close — the editor that had just opened. Checking the DOM has no such race: it reflects
// whatever the browser most recently, actually focused.
const cellAlreadyHasFocus = (cell: HTMLTableCellElement | null): boolean =>
  cell !== null && (document.activeElement === cell || cell.contains(document.activeElement));
// Issue #227: the array-op keyboard accelerators (Insert/Delete/Ctrl+↑/Ctrl+↓) — undefined
// members are the "not applicable to this cell" case (sorted array, immutable column, or a
// boundary element with no further move), same convention onCopy's absence-of-callers-through-
// DiffRow already relies on; DiskCell just no-ops via optional chaining rather than checking
// anything itself, keeping the "which ops apply here" decision entirely on DiffRow's side.
export interface ArrayOpHandlers {
  add?: () => void;
  remove?: () => void;
  moveUp?: () => void;
  moveDown?: () => void;
}

export function DiskCell({
  style, isFocused, onFocusCell, onDragStart, onDrop, onCopy, onCut, onPaste, arrayOp, dataVscodeContext, children,
}: Readonly<{
  style: React.CSSProperties;
  isFocused: boolean;
  onFocusCell: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  // Issue #224 / ADR-0034: Ctrl+C on the focused cell — DiffRow already knows this column's own
  // model value (modelValue.ts) by the time it builds this prop, so this is a plain thunk, not a
  // value: the cell doesn't need to know *what* it copies, only *when* (see onKeyDown below).
  onCopy: () => void;
  // Issue #225 / ADR-0034: Ctrl+X/Ctrl+V on the focused cell — same "plain thunk, not a value"
  // shape as onCopy above (DiffRow already knows how to read/coerce/commit this column's value by
  // the time it builds these props). Both optional and absent (not merely a no-op) wherever the
  // gesture doesn't apply — undefined on an immutable column (refuse silently, no clipboard round
  // trip even attempted), and onPaste additionally undefined for a formKey column (its own
  // QuickPick editor is already the paste target once opened, #210/#218 — see DiffRow's
  // computeClipboardOps). DiskCell itself doesn't know or care why either is absent, only that it
  // is — same convention arrayOp's individual members already use.
  onCut?: () => void;
  onPaste?: () => void;
  // Issue #227: Insert/Delete/Ctrl+↑/Ctrl+↓ on the focused cell — same "plain thunk, not a
  // value" shape as onCopy above. Absent entirely (not just individually undefined members) on
  // any cell that isn't an array parent/element row.
  arrayOp?: ArrayOpHandlers;
  // Issue #227: the array-element/array-parent right-click menu's gating attribute — same
  // mechanism the pending cell and column header already use (data-vscode-context + VS Code's
  // native webview/context contribution), just carried here instead of hand-built per call site
  // since DiskCell is the one element both array cell shapes (summary and leaf) render through.
  dataVscodeContext?: string;
  children: React.ReactNode;
}>) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTableCellElement>(null);
  // A focused FormKey link is not an editor — only a form control suppresses the drag.
  const isFormControl = (t: EventTarget | null) =>
    t instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName);

  // `editing` is a trigger-only dependency — the check body never reads it, but its flip to false
  // (the editor closing on blur) is exactly the moment focus needs to move from the now-unmounted
  // input back to the `<td>`, and only a dependency change re-runs a layout effect. Without it
  // here, the effect would stay silent from the render where the editor closes until something
  // else happened to touch `isFocused`.
  useLayoutEffect(() => {
    if (isFocused && !cellAlreadyHasFocus(ref.current)) ref.current?.focus();
  }, [isFocused, editing]);

  return (
    <td
      ref={ref}
      tabIndex={0}
      style={{ ...style, ...(isFocused ? focusedCellStyle : undefined) }}
      draggable={!editing}
      onClick={onFocusCell}
      // Issue #223 / ADR-0034: F2 opens the focused cell's editor. This `<td>` is the one real
      // focused DOM element (see the class comment above), so it's where the keydown has to
      // land — but which control to open is the leaf's own business (it varies per type and its
      // "is open" state is local to the leaf), so this doesn't reach in and flip any state
      // itself. Instead it dispatches a real click at whichever element inside its own subtree
      // the currently-rendered leaf marked `data-open-trigger` — the exact element that leaf's
      // own click-to-open handler already lives on (gated there on `isFocused`, which is true
      // here by construction: F2 only ever fires on the focused `<td>`). An immutable cell or a
      // struct/array summary row carries no such element, so this is a harmless no-op there —
      // matching "F2 opens nothing" for both, with no separate check needed.
      // Issue #224 / ADR-0034: Ctrl+C copies the focused cell's model value — gated on `!editing`
      // (the same state that already suppresses `draggable` above) rather than on `isFocused`,
      // for the same reason F2 needs no `isFocused` check of its own: only the DOM-focused `<td>`
      // ever receives a real keydown in the first place. The gate matters here in a way it
      // doesn't for F2, though — while a form control inside this cell has real focus (an open
      // editor, or an immutable cell's read-only surface, #201), Ctrl+C must stay the browser's
      // native "copy the selected text" instead: intercepting it here would clobber a user's
      // in-progress partial-text selection with the whole model value. `editing` is exactly "a
      // form control inside me has focus", so gating on it is what keeps that native behavior
      // intact — the spec's "no focused form control" condition for this handler to apply.
      // Issue #225 / ADR-0034: Ctrl+X/Ctrl+V are the mutating half of the same clipboard contract
      // Ctrl+C belongs to — gated on `!editing` for the identical reason (an open editor's own
      // native cut/paste, already working via #223's select-on-focus, must stay untouched), and
      // additionally on the corresponding prop being defined, the same "arrayOp member present or
      // absent" convention below: absent on an immutable column (refuse silently — no clipboard
      // round trip is even attempted) and, for onPaste only, absent on a formKey column too (see
      // the prop's own doc comment above and DiffRow's computeClipboardOps).
      // Issue #227 / ADR-0034: Insert/Delete/Ctrl+↑/Ctrl+↓ are accelerators onto the array-op
      // right-click menu, not a separate feature — same "menu is canonical, key is a shortcut"
      // relationship F2 already has to click-to-open. Gated on `!editing` like Ctrl+C above (an
      // open editor's own Delete/Insert keystrokes must reach the input, not restage the array),
      // and on the corresponding `arrayOp` member being defined, which is DiffRow's decision
      // (absent for a sorted array, an immutable column, or — for move — an array boundary) —
      // this handler never re-derives that gate, only dispatches to whatever it's handed.
      onKeyDown={e => {
        if (e.key === 'F2') ref.current?.querySelector<HTMLElement>('[data-open-trigger]')?.click();
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !editing) {
          e.preventDefault();
          onCopy();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && !editing && onCut) {
          e.preventDefault();
          onCut();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !editing && onPaste) {
          e.preventDefault();
          onPaste();
        } else if (e.key === 'Insert' && !editing && arrayOp?.add) {
          e.preventDefault();
          arrayOp.add();
        } else if (e.key === 'Delete' && !editing && arrayOp?.remove) {
          e.preventDefault();
          arrayOp.remove();
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp' && !editing && arrayOp?.moveUp) {
          e.preventDefault();
          arrayOp.moveUp();
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown' && !editing && arrayOp?.moveDown) {
          e.preventDefault();
          arrayOp.moveDown();
        }
      }}
      onFocus={e => { if (isFormControl(e.target)) setEditing(true); }}
      onBlur={e => { if (isFormControl(e.target)) setEditing(false); }}
      onDragStart={onDragStart}
      onDragOver={e => e.preventDefault()}
      onDrop={onDrop}
      data-vscode-context={dataVscodeContext}
    >
      {children}
    </td>
  );
}
