import React from 'react';
import type { RecordDetail } from './types';

interface PluginHeaderProps {
  override: RecordDetail;
  isImmutable: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

// Issue #209: this used to also own "Add Master…" (a button + its own hand-drawn candidate
// dropdown, gated on isHeaderRecord/showMasterPicker/loadedPlugins) — deleted, not adapted, along
// with the rest of the column-header's hand-drawn chrome (ColumnHeaderMenu, PluginTargetPicker).
// Add Master is reachable only via the column header's native right-click menu now (ADR-0033: no
// standalone control once an action is right-click-reachable, same rule #207 applied to the
// inline revert button) — see RecordPanel.tsx's data-vscode-context wiring and
// recordUtils.ts' currentMasters (moved there, since RecordPanel needs it to build that context
// and to compute the appended list when the native command's broadcast comes back in).
export function PluginHeader({
  override: o, isImmutable, collapsed, onToggleCollapse,
}: PluginHeaderProps) {
  return (
    <div>
      {/* Issue #3: left-click the plugin-name chip collapses/expands this column. */}
      <div onClick={onToggleCollapse} style={{ cursor: 'pointer' }}>{o.plugin}</div>
      {!collapsed && (
        <>
          <div style={{ fontWeight: 400, opacity: 0.6, fontSize: '11px' }}>
            [{o.loadOrderIndex}]{o.isWinner ? ' ✓ winner' : ''}
          </div>
          {isImmutable && (
            <div style={{ marginTop: 3, fontSize: '10px', opacity: 0.55, fontStyle: 'italic' }}>
              (read-only)
            </div>
          )}
        </>
      )}
    </div>
  );
}
