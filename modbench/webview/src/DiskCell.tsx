import React, { useLayoutEffect, useRef } from 'react';
import { focusedCellStyle } from './gridStyles';

// A field grid's value cell.
//
// ADR-0034: this is where "is this the focused cell" becomes real DOM focus, not
// just painted state — `tabIndex` makes the cell itself a focusable element, and the effect below
// calls `.focus()` on it whenever it becomes (or re-becomes, after a re-render) the panel's
// focused cell. That is deliberate, not a convenience: Ctrl+C needs `keydown` to land on a
// real focused element.
const cellAlreadyHasFocus = (cell: HTMLTableCellElement | null): boolean =>
  cell !== null && (document.activeElement === cell || cell.contains(document.activeElement));

// The four array-arity/order ops behind Insert/Delete/Ctrl+↑/Ctrl+↓
// — DiffRow builds whichever of these apply to this exact (row, column) cell (add only on a
// mutable unsorted-array's own row; remove/moveUp/moveDown only on a mutable unsorted-array
// element's row) and leaves the rest undefined, so an inapplicable key is inert by construction,
// the same "no distinct affordance, just does nothing" rule every other immutable gesture follows.
export interface ArrayOps {
  add?: () => void;
  remove?: () => void;
  moveUp?: () => void;
  moveDown?: () => void;
}

export function DiskCell({
  style, isFocused, onFocusCell, onCopy, arrayOps, vscodeContext, children,
}: Readonly<{
  style: React.CSSProperties;
  isFocused: boolean;
  onFocusCell: () => void;
  // ADR-0034: Ctrl+C on the focused cell — DiffRow already knows this column's own
  // model value (modelValue.ts) by the time it builds this prop, so this is a plain thunk, not a
  // value: the cell doesn't need to know *what* it copies, only *when*.
  onCopy: () => void;
  // Insert/Delete/Ctrl+↑/Ctrl+↓ accelerators onto the same ops the right-click menu
  // offers — pure in-webview state (the array's own new value writes through the ordinary
  // onEditCell path), no extension-host round trip needed for the keys themselves.
  arrayOps?: ArrayOps;
  // The already-combined `data-vscode-context` JSON string
  // (recordUtils.ts's combineVscodeContexts) VS Code's own `contributes.menus["webview/context"]`
  // gates on — undefined when this cell carries no structural-op menu at all.
  vscodeContext?: string;
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
      data-vscode-context={vscodeContext}
      onClick={onFocusCell}
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
          e.preventDefault();
          onCopy();
          return;
        }
        // ADR-0034: F2 is one of xEdit's three "open the editor" triggers, and the only one
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
          return;
        }
        if (e.key === 'Insert' && arrayOps?.add) { e.preventDefault(); arrayOps.add(); return; }
        if (e.key === 'Delete' && arrayOps?.remove) { e.preventDefault(); arrayOps.remove(); return; }
        if (e.ctrlKey && e.key === 'ArrowUp' && arrayOps?.moveUp) { e.preventDefault(); arrayOps.moveUp(); return; }
        if (e.ctrlKey && e.key === 'ArrowDown' && arrayOps?.moveDown) { e.preventDefault(); arrayOps.moveDown(); }
      }}
    >
      {children}
    </td>
  );
}
