import React, { useLayoutEffect, useRef } from 'react';
import { focusedCellStyle } from './gridStyles';

// A field grid's value cell.
//
// Issue #222 / ADR-0034: this is where "is this the focused cell" becomes real DOM focus, not
// just painted state — `tabIndex` makes the cell itself a focusable element, and the effect below
// calls `.focus()` on it whenever it becomes (or re-becomes, after a re-render) the panel's
// focused cell. That is deliberate, not a convenience: Ctrl+C (#224) needs `keydown` to land on a
// real focused element.
//
// #410/ADR-0041: reduced to focus + copy. Drag-to-copy, the F2/second-click editor trigger, the
// Ctrl+X/Ctrl+V mutating half of the clipboard contract, the array-op accelerators and the
// data-vscode-context menu gating all retired with the write path they staged through — the
// endpoints behind them are gone, so an affordance left here would lead nowhere. Ctrl+C survives
// because copying a value out of a viewer is a read.
const cellAlreadyHasFocus = (cell: HTMLTableCellElement | null): boolean =>
  cell !== null && (document.activeElement === cell || cell.contains(document.activeElement));

export function DiskCell({
  style, isFocused, onFocusCell, onCopy, children,
}: Readonly<{
  style: React.CSSProperties;
  isFocused: boolean;
  onFocusCell: () => void;
  // Issue #224 / ADR-0034: Ctrl+C on the focused cell — DiffRow already knows this column's own
  // model value (modelValue.ts) by the time it builds this prop, so this is a plain thunk, not a
  // value: the cell doesn't need to know *what* it copies, only *when*.
  onCopy: () => void;
  children: React.ReactNode;
}>) {
  const ref = useRef<HTMLTableCellElement>(null);

  useLayoutEffect(() => {
    if (isFocused && !cellAlreadyHasFocus(ref.current)) ref.current?.focus();
  }, [isFocused]);

  return (
    <td
      ref={ref}
      tabIndex={0}
      style={{ ...style, ...(isFocused ? focusedCellStyle : undefined) }}
      onClick={onFocusCell}
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
          e.preventDefault();
          onCopy();
          return;
        }
        // #415 / ADR-0034: F2 is one of xEdit's three "open the editor" triggers, and the only one
        // that is a key rather than a click. Dispatched at the cell's own editable element rather
        // than lifted into a callback, so the cell content stays the single owner of what opening
        // means: a cell with nothing editable in it (a read-only column, a struct row) renders no
        // `data-open-trigger` at all, so F2 is inert there by construction rather than by a second
        // copy of the editability rule living here.
        if (e.key === 'F2') {
          const trigger = e.currentTarget.querySelector<HTMLElement>('[data-open-trigger]');
          if (trigger) {
            e.preventDefault();
            trigger.click();
          }
        }
      }}
    >
      {children}
    </td>
  );
}
