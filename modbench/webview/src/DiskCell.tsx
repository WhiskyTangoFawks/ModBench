import React, { useState } from 'react';

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
export function DiskCell({ style, onDragStart, onDrop, children }: Readonly<{
  style: React.CSSProperties;
  onDragStart: () => void;
  onDrop: () => void;
  children: React.ReactNode;
}>) {
  const [editing, setEditing] = useState(false);
  // A focused FormKey link is not an editor — only a form control suppresses the drag.
  const isFormControl = (t: EventTarget | null) =>
    t instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName);

  return (
    <td
      style={{ ...style, cursor: editing ? undefined : 'grab' }}
      draggable={!editing}
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
