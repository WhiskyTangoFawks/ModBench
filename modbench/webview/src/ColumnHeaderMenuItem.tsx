import React from 'react';
import { baseCell } from './gridStyles';

// Issue #3: a single `role="menuitem"` row shared by every context menu in the record panel
// (ColumnHeaderMenu, PendingCellMenu, PluginTargetPicker) — same click/keyboard-activate/hover
// chrome each of them would otherwise repeat.
interface ColumnHeaderMenuItemProps {
  label: string;
  disabled?: boolean;
  onActivate: () => void;
}

export function ColumnHeaderMenuItem({ label, disabled, onActivate }: ColumnHeaderMenuItemProps) {
  const activate = () => { if (!disabled) onActivate(); };
  return (
    <li
      role="menuitem"
      aria-disabled={disabled ? 'true' : undefined}
      tabIndex={disabled ? -1 : 0}
      style={{ cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, padding: baseCell.padding }}
      onClick={activate}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') activate(); }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--vscode-list-hoverBackground,#2a2d2e)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = ''; }}
    >
      {label}
    </li>
  );
}
