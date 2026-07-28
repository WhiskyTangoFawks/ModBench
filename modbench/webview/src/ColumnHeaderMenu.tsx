import React, { useEffect } from 'react';
import { ColumnHeaderMenuItem } from './ColumnHeaderMenuItem';

// Issue #3: right-click on a plugin column header. Modeled on DownloadsApp.tsx's
// RowContextMenu (role="menu"/"menuitem", position:fixed at the click coordinates,
// closes on outside click or Escape) — that is this webview's only existing
// context-menu precedent, kept local here since it's mEdit-specific vocabulary
// ("Remove Override"), not shared across the Mod-Management boundary.
interface ColumnHeaderMenuProps {
  x: number;
  y: number;
  disabledRemove: boolean;
  onClose: () => void;
  onCopyAllToPending: () => void;
  onCopyAsNewRecord: () => void;
  onCopyAsOverride: () => void;
  onRemoveOverride: () => void;
}

export function ColumnHeaderMenu({ x, y, disabledRemove, onClose, onCopyAllToPending, onCopyAsNewRecord, onCopyAsOverride, onRemoveOverride }: ColumnHeaderMenuProps) {
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
        // No space after the comma in the var() fallback — see RowContextMenu in
        // DownloadsApp.tsx: happy-dom silently drops color-valued styles containing
        // "var(--x, y)" with a space, but accepts "var(--x,y)".
        backgroundColor: 'var(--vscode-menu-background,#3c3c3c)',
        color: 'var(--vscode-menu-foreground,#ccc)',
        border: '1px solid var(--vscode-menu-border,#454545)',
        borderRadius: 2,
        zIndex: 1000,
      }}
    >
      <ColumnHeaderMenuItem label="Copy All to Pending" onActivate={onCopyAllToPending} />
      <ColumnHeaderMenuItem label="Copy as New Record" onActivate={onCopyAsNewRecord} />
      <ColumnHeaderMenuItem label="Copy as Override…" onActivate={onCopyAsOverride} />
      <ColumnHeaderMenuItem label="Remove Override" disabled={disabledRemove} onActivate={onRemoveOverride} />
    </ul>
  );
}
