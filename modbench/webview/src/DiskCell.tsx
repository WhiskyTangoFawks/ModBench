import React, { useLayoutEffect, useRef } from 'react';
import { focusedCellStyle } from './gridStyles';
import type { CellContext } from './recordUtils';

// `tabIndex` plus the effect below make the focused cell a really focused DOM element, not just
// painted state: the arrow keys' `keydown` lands on it.
const cellAlreadyHasFocus = (cell: HTMLTableCellElement | null): boolean =>
  cell !== null && (document.activeElement === cell || cell.contains(document.activeElement));

const inside = (target: EventTarget, selector: string): boolean =>
  target instanceof Element && target.closest(selector) !== null;

const carriesText = (transfer: DataTransfer): boolean => transfer.types.includes('text/plain');

// Every gesture that opens the cell's editor lands on its `data-open-trigger`, so a cell with
// nothing editable is inert. The click sent there is an open, not a first click that only focuses.
let opening = false;
export function openEditor(cell: HTMLElement): void {
  opening = true;
  cell.querySelector<HTMLElement>('[data-open-trigger]')?.click();
  opening = false;
}

export function DiskCell({
  style, title, colSpan, isFocused, onFocusCell, onDoubleClick, onActivate, context, dragText, onDropText, children,
}: Readonly<{
  style: React.CSSProperties;
  title?: string;
  colSpan?: number;
  isFocused: boolean;
  onFocusCell: () => void;
  onDoubleClick?: () => void;
  onActivate?: () => void;
  context: CellContext;
  // What dragging this cell carries; absent when there is nothing to drag.
  dragText?: string;
  // What dropping text here does; absent where nothing can be dropped.
  onDropText?: (text: string) => void;
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
      colSpan={colSpan}
      style={{ ...style, ...(isFocused ? focusedCellStyle : undefined) }}
      data-vscode-context={JSON.stringify(context)}
      data-focused-cell={isFocused || undefined}
      draggable={dragText !== undefined}
      onDragStart={e => {
        if (dragText === undefined || inside(e.target, '[data-editor]')) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', dragText);
      }}
      onDragOver={e => {
        if (!onDropText || !carriesText(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={e => {
        if (!onDropText || !carriesText(e.dataTransfer)) return;
        e.preventDefault();
        onDropText(e.dataTransfer.getData('text/plain'));
      }}
      onClickCapture={e => {
        if (!opening && !isFocused && !e.ctrlKey && !e.metaKey && inside(e.target, '[data-open-trigger]')) {
          e.stopPropagation();
          onFocusCell();
        }
      }}
      onClick={e => {
        onFocusCell();
        onActivate?.();
        if (isFocused && !inside(e.target, '[data-open-trigger]')) openEditor(e.currentTarget);
      }}
      onDoubleClick={e => { onDoubleClick?.(); openEditor(e.currentTarget); }}
      onFocus={e => { if (e.target === e.currentTarget && !isFocused) onFocusCell(); }}
    >
      {children}
    </td>
  );
}
