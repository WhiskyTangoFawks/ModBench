import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { focusedCellStyle } from './gridStyles';
import { beginDrag, currentDrag, endDrag, type CellDrag } from './cellDrag';
import { cellContext, combineVscodeContexts } from './recordUtils';
import { EXTENSION_TO_WEBVIEW, parseExtensionToWebview, type ExtensionToWebview } from './messages';

// `tabIndex` plus the effect below make the focused cell (editor.md, The focused cell) a really
// focused DOM element, not just painted state: the arrow keys' `keydown` lands on it, and the panel reads an open editor
// from where the focus goes.
const cellAlreadyHasFocus = (cell: HTMLTableCellElement | null): boolean =>
  cell !== null && (document.activeElement === cell || cell.contains(document.activeElement));

const inside = (target: EventTarget, selector: string): boolean =>
  target instanceof Element && target.closest(selector) !== null;

// Every gesture that opens the cell's editor lands on its `data-open-trigger`, so a cell with
// nothing editable is inert. The click sent there is an open, not a first click that only focuses.
let opening = false;
function openEditor(cell: HTMLTableCellElement, target: EventTarget): void {
  if (inside(target, '[data-editor]')) return;
  opening = true;
  cell.querySelector<HTMLElement>('[data-open-trigger]')?.click();
  opening = false;
}

const messageOf = (event: MessageEvent<unknown>): ExtensionToWebview | undefined => {
  try {
    return parseExtensionToWebview(event.data);
  } catch {
    return undefined;
  }
};

export function DiskCell({
  style, title, isFocused, onFocusCell, onDoubleClick, copyText, paste, drag, landing, contexts = [], children,
}: Readonly<{
  style: React.CSSProperties;
  title?: string;
  isFocused: boolean;
  onFocusCell: () => void;
  onDoubleClick?: () => void;
  // What Ctrl+C on the focused cell copies (editor-fields.md, By type); absent when the cell
  // copies nothing. The palette's copy value reads it off the cell too.
  copyText?: string;
  // What Ctrl+V's text writes here, parsed as this cell's field; absent where the cell takes none.
  paste?: (text: string) => void;
  // What dragging this cell carries; absent when there is nothing to drag.
  drag?: CellDrag;
  // What dropping a drag here does; absent when the drop cannot land.
  landing?: (dragged: CellDrag) => (() => void) | undefined;
  // What this cell's right-click menu is gated on beyond every cell's own: each is merged into the
  // `data-vscode-context` VS Code's `contributes.menus["webview/context"]` reads.
  contexts?: readonly (object | undefined)[];
  children: React.ReactNode;
}>) {
  const ref = useRef<HTMLTableCellElement>(null);

  useLayoutEffect(() => {
    if (isFocused && !cellAlreadyHasFocus(ref.current)) ref.current?.focus();
  }, [isFocused]);

  useEffect(() => {
    if (!isFocused) return;
    const actOnFocusedCell = (event: MessageEvent<unknown>) => {
      const message = messageOf(event);
      const cell = ref.current;
      if (!cell || !message) return;
      if (message.type === EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR) openEditor(cell, document.activeElement ?? cell);
      if (message.type === EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL) paste?.(message.text);
    };
    window.addEventListener('message', actOnFocusedCell);
    return () => window.removeEventListener('message', actOnFocusedCell);
  }, [isFocused, paste]);

  return (
    <td
      ref={ref}
      tabIndex={0}
      title={title}
      style={{ ...style, ...(isFocused ? focusedCellStyle : undefined) }}
      data-vscode-context={combineVscodeContexts(cellContext(copyText), ...contexts)}
      data-focused-cell={isFocused || undefined}
      data-copy-text={copyText}
      draggable={drag !== undefined}
      onDragStart={e => {
        if (!drag || inside(e.target, '[data-editor]')) { e.preventDefault(); return; }
        beginDrag(drag);
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', copyText ?? '');
      }}
      onDragEnd={endDrag}
      onDragOver={e => {
        const current = currentDrag();
        if (!current || !landing?.(current)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={e => {
        const current = currentDrag();
        const land = current && landing?.(current);
        if (!land) return;
        e.preventDefault();
        land();
      }}
      onClickCapture={e => {
        if (!opening && !isFocused && !e.ctrlKey && !e.metaKey && inside(e.target, '[data-open-trigger]')) {
          e.stopPropagation();
          onFocusCell();
        }
      }}
      onClick={e => {
        onFocusCell();
        if (isFocused && !inside(e.target, '[data-open-trigger]')) openEditor(e.currentTarget, e.target);
      }}
      onDoubleClick={e => { onDoubleClick?.(); openEditor(e.currentTarget, e.target); }}
      onFocus={e => { if (e.target === e.currentTarget && !isFocused) onFocusCell(); }}
    >
      {children}
    </td>
  );
}
