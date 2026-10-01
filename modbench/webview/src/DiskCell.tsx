import React, { useLayoutEffect, useRef } from 'react';
import { focusedCellStyle } from './gridStyles';
import { copyValue } from './nativeBridge';

// ADR-0018: `tabIndex` plus the effect below make the focused cell a really focused DOM element,
// not just painted state — Ctrl+C needs `keydown` to land on a real focused element.
const cellAlreadyHasFocus = (cell: HTMLTableCellElement | null): boolean =>
  cell !== null && (document.activeElement === cell || cell.contains(document.activeElement));

// An op that does not apply to this exact (row, column) cell is left undefined, so an inapplicable
// key is inert by construction — the same "no distinct affordance, just does nothing" rule every
// other immutable gesture follows.
export interface ArrayOps {
  add?: () => void;
  remove?: () => void;
  moveUp?: () => void;
  moveDown?: () => void;
}

export function DiskCell({
  style, isFocused, onFocusCell, copyText, arrayOps, vscodeContext, children,
}: Readonly<{
  style: React.CSSProperties;
  isFocused: boolean;
  onFocusCell: () => void;
  // ADR-0018: what Ctrl+C on the focused cell copies; absent when the cell copies nothing. The
  // palette's copy value reads it off the cell too.
  copyText?: string;
  // Insert/Delete/Ctrl+↑/Ctrl+↓ accelerators onto the same ops the right-click menu offers,
  // each posting the same envelope the menu entry does, with no extension-host round trip for
  // the keys themselves.
  arrayOps?: ArrayOps;
  // The already-combined `data-vscode-context` JSON string VS Code's own
  // `contributes.menus["webview/context"]` gates on — undefined when this cell carries no
  // structural-op menu at all.
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
      data-focused-cell={isFocused || undefined}
      data-copy-text={copyText}
      onClick={onFocusCell}
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
          e.preventDefault();
          if (copyText !== undefined) copyValue(copyText);
          return;
        }
        // ADR-0018: F2 is xEdit's only keyboard "open the editor" trigger. Dispatched at the
        // cell's own editable element, so a cell with nothing editable renders no
        // `data-open-trigger` and F2 is inert there by construction.
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
