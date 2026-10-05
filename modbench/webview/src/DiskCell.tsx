import React, { useLayoutEffect, useRef } from 'react';
import { focusedCellStyle } from './gridStyles';
import { beginDrag, currentDrag, endDrag, type CellDrag } from './cellDrag';
import type { CellContext } from './recordUtils';

// `tabIndex` plus the effect below make the focused cell a really focused DOM element, not just
// painted state: the arrow keys' `keydown` lands on it.
const cellAlreadyHasFocus = (cell: HTMLTableCellElement | null): boolean =>
  cell !== null && (document.activeElement === cell || cell.contains(document.activeElement));

const inside = (target: EventTarget, selector: string): boolean =>
  target instanceof Element && target.closest(selector) !== null;

// Every gesture that opens the cell's editor lands on its `data-open-trigger`, so a cell with
// nothing editable is inert. The click sent there is an open, not a first click that only focuses.
let opening = false;
export function openEditor(cell: HTMLElement): void {
  opening = true;
  cell.querySelector<HTMLElement>('[data-open-trigger]')?.click();
  opening = false;
}

export function DiskCell({
  style, title, isFocused, onFocusCell, onDoubleClick, context, drag, landing, children,
}: Readonly<{
  style: React.CSSProperties;
  title?: string;
  isFocused: boolean;
  onFocusCell: () => void;
  onDoubleClick?: () => void;
  context: CellContext;
  // What dragging this cell carries; absent when there is nothing to drag.
  drag?: CellDrag;
  // What dropping a drag here does; absent when the drop cannot land.
  landing?: (dragged: CellDrag) => (() => void) | undefined;
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
      title={title}
      style={{ ...style, ...(isFocused ? focusedCellStyle : undefined) }}
      data-vscode-context={JSON.stringify(context)}
      data-focused-cell={isFocused || undefined}
      draggable={drag !== undefined}
      onDragStart={e => {
        if (!drag || inside(e.target, '[data-editor]')) { e.preventDefault(); return; }
        beginDrag(drag);
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', context.copyText ?? '');
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
        if (isFocused && !inside(e.target, '[data-open-trigger]')) openEditor(e.currentTarget);
      }}
      onDoubleClick={e => { onDoubleClick?.(); openEditor(e.currentTarget); }}
      onFocus={e => { if (e.target === e.currentTarget && !isFocused) onFocusCell(); }}
    >
      {children}
    </td>
  );
}
