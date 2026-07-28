import React from 'react';
import type { RecordDetail } from './types';
import type { PluginInfo } from './RecordSessionClient';

interface PluginHeaderProps {
  override: RecordDetail;
  isImmutable: boolean;
  isHeaderRecord: boolean;
  showMasterPicker: boolean;
  loadedPlugins: PluginInfo[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenMasterPicker: () => void;
  onCloseMasterPicker: () => void;
  onAddMaster: (newMasters: string[]) => void;
}

// Issue #86: the header record's "masters" field, pending-aware (a still-unsaved Add Master
// already counts as current — matches the backend's CheckMasterEdit baseline convention).
function currentMasters(o: RecordDetail): string[] {
  const disk = o.fields.find(f => f.metadata.name === 'masters')?.value;
  const pending = o.pendingFields?.masters;
  const value = Array.isArray(pending) ? pending : disk;
  return Array.isArray(value) ? value as string[] : [];
}

export function PluginHeader({
  override: o, isImmutable, isHeaderRecord,
  showMasterPicker, loadedPlugins,
  collapsed, onToggleCollapse,
  onOpenMasterPicker, onCloseMasterPicker, onAddMaster,
}: PluginHeaderProps) {
  const masters = currentMasters(o);
  const masterCandidates = loadedPlugins.filter(p => p.name !== o.plugin && !masters.includes(p.name));
  const btnStyle: React.CSSProperties = {
    fontSize: '10px',
    padding: '1px 5px',
    marginLeft: 4,
    cursor: 'pointer',
    background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
    color: 'var(--vscode-button-secondaryForeground, #ccc)',
    border: '1px solid var(--vscode-button-secondaryHoverBackground, #45494e)',
    borderRadius: 2,
  };
  return (
    <div>
      {/* Issue #3: left-click the plugin-name chip collapses/expands this column;
          kept as its own click target (not the whole <th>) so it never swallows the
          Add-Master button click below it. */}
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
      {/* Issue #111: no mode gate — a mutable column's structural actions are always available. */}
      {!collapsed && !isImmutable && (
        <div style={{ marginTop: 3, position: 'relative' }}>
          {isHeaderRecord && (
            <>
              <button style={btnStyle} onClick={onOpenMasterPicker}>
                Add Master…
              </button>
              {showMasterPicker && (
                // onMouseDown on items fires before onBlur, so selection works correctly
                <div
                  onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) onCloseMasterPicker(); }}
                  tabIndex={-1}
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    zIndex: 10,
                    background: 'var(--vscode-dropdown-background, #3c3c3c)',
                    border: '1px solid var(--vscode-dropdown-border, #555)',
                    borderRadius: 2,
                    minWidth: 180,
                    maxHeight: 200,
                    overflowY: 'auto',
                    outline: 'none',
                  }}
                >
                  {masterCandidates.length === 0 && (
                    <div style={{ padding: '4px 8px', opacity: 0.5, fontSize: '11px' }}>No plugins to add</div>
                  )}
                  {masterCandidates.map(p => (
                    <div
                      key={p.name}
                      onMouseDown={() => { onAddMaster([...masters, p.name]); onCloseMasterPicker(); }}
                      style={{
                        padding: '4px 8px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        color: 'var(--vscode-dropdown-foreground, #ccc)',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--vscode-list-hoverBackground, #2a2d2e)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                    >
                      {p.name}
                      <span style={{ opacity: 0.55, marginLeft: 6 }}>[{p.loadOrderIndex}]</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
