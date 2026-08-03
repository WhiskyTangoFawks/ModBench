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
export function DiskCell({ style, isFocused, onFocusCell, onDragStart, onDrop, children }: Readonly<{
  style: React.CSSProperties;
  isFocused: boolean;
  onFocusCell: () => void;
  onDragStart: () => void;
  onDrop: () => void;
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
      onKeyDown={e => {
        if (e.key === 'F2') ref.current?.querySelector<HTMLElement>('[data-open-trigger]')?.click();
      }}
      onFocus={e => { if (isFormControl(e.target)) setEditing(true); }}
      onBlur={e => { if (isFormControl(e.target)) setEditing(false); }}
      onDragStart={onDragStart}
      onDragOver={e => e.preventDefault()}
      onDrop={onDrop}
    >
      {children}
    </td>
  );
}
