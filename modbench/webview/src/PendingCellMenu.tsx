import React, { useEffect } from 'react';
import { ColumnHeaderMenuItem } from './ColumnHeaderMenuItem';

// Issue #139: right-click on a pending value. Save Group / Revert Group, both scoped to that
// change's whole ChangeGroup (ADR-0029), never to part of one. Same chrome/close behavior as
// ColumnHeaderMenu (role="menu", position:fixed at the click, closes on outside click or Escape).
interface PendingCellMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  // Issue #203: plain-click on a pending cell no longer reveals it in the Pending Changes tree
  // (the cell is directly editable now) — the gesture moves here, first in the menu since it's
  // the read-only "what is this" action ahead of the two mutating ones.
  onReveal: () => void;
  onSaveGroup: () => void;
  onRevertGroup: () => void;
}

export function PendingCellMenu({ x, y, onClose, onReveal, onSaveGroup, onRevertGroup }: Readonly<PendingCellMenuProps>) {
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);

  return (
    <ul
      role="menu"
      style={{
        position: 'fixed',
        top: y,
        left: x,
        listStyle: 'none',
        margin: 0,
        padding: 4,
        backgroundColor: 'var(--vscode-menu-background,#3c3c3c)',
        color: 'var(--vscode-menu-foreground,#ccc)',
        border: '1px solid var(--vscode-menu-border,#454545)',
        borderRadius: 2,
        zIndex: 1000,
      }}
    >
      <ColumnHeaderMenuItem label="Reveal in Pending Changes Tree" onActivate={onReveal} />
      <ColumnHeaderMenuItem label="Save Group" onActivate={onSaveGroup} />
      <ColumnHeaderMenuItem label="Revert Group" onActivate={onRevertGroup} />
    </ul>
  );
}
