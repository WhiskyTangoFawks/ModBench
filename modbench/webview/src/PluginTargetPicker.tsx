import React, { useEffect } from 'react';
import { ColumnHeaderMenuItem } from './ColumnHeaderMenuItem';
import type { PluginInfo } from './RecordSessionClient';

// Issue #3: the target-plugin picker for "Copy All to Pending"/"Copy as New Record". More than
// one plugin can be mutable at once (every non-implicit-master plugin in the loadout), so there
// is no single "active editable plugin" to assume — same reason the #86 "Copy as Override…"
// button picker in PluginHeader exists. Positioned/closed like ColumnHeaderMenu (position:fixed
// at the triggering click, closes on outside click or Escape) since it opens from that menu.
interface PluginTargetPickerProps {
  x: number;
  y: number;
  targets: PluginInfo[];
  onClose: () => void;
  onSelect: (plugin: string) => void;
}

export function PluginTargetPicker({ x, y, targets, onClose, onSelect }: PluginTargetPickerProps) {
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
        minWidth: 180,
        maxHeight: 200,
        overflowY: 'auto',
        backgroundColor: 'var(--vscode-menu-background,#3c3c3c)',
        color: 'var(--vscode-menu-foreground,#ccc)',
        border: '1px solid var(--vscode-menu-border,#454545)',
        borderRadius: 2,
        zIndex: 1000,
      }}
    >
      {targets.length === 0 && (
        <li style={{ padding: '4px 8px', opacity: 0.5, fontSize: '11px' }}>No mutable plugins</li>
      )}
      {targets.map(p => (
        <ColumnHeaderMenuItem key={p.name} label={p.name} onActivate={() => onSelect(p.name)} />
      ))}
    </ul>
  );
}
