import React from 'react';
import { COLLAPSED_COLUMN_WIDTH } from './gridStyles';

const edgeStyle: React.CSSProperties = {
  position: 'absolute', top: 0, right: 0, bottom: 0, width: 5, cursor: 'col-resize',
};

/** editor.md, Columns, story 5: the right edge of a header cell, whose drag resizes its column.
 *  The header cell is `position: relative`. */
export function ColumnEdge({ onResize }: Readonly<{ onResize: (width: number) => void }>) {
  function startResize(e: React.MouseEvent<HTMLElement>) {
    const header = e.currentTarget.closest('th');
    if (e.button !== 0 || !header) return;
    const startX = e.clientX;
    const startWidth = header.getBoundingClientRect().width;
    const move = (m: MouseEvent) => onResize(Math.max(COLLAPSED_COLUMN_WIDTH, startWidth + m.clientX - startX));
    // The click that ends a drag lands on whatever holds both its ends, the header included, and
    // is not a click on the header.
    const swallowClick = (c: MouseEvent) => c.stopPropagation();
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      window.addEventListener('click', swallowClick, true);
      setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }
  return <div data-column-edge style={edgeStyle} onMouseDown={startResize} />;
}
