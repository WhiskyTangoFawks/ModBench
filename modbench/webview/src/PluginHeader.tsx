import React from 'react';
import type { CompareOverride } from './types';
import type { ColumnStatus } from '../../src/wire/messages';
import { headerCell } from './gridStyles';
import { ColumnEdge } from './ColumnEdge';
import { ExpandArrow } from './ExpandArrow';

interface PluginHeaderProps {
  override: CompareOverride;
  status: ColumnStatus | undefined;
  isFile: boolean;
  onOpen: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onResize: (width: number) => void;
  // The column's own styling, shared with its cells so the header and the cells cannot disagree.
  style: React.CSSProperties;
  vscodeContext?: string;
}

export function PluginHeader({
  override: o, status, isFile, onOpen, collapsed, onToggleCollapse, onResize, style, vscodeContext,
}: Readonly<PluginHeaderProps>) {
  return (
    <th
      style={{ ...headerCell, position: 'relative', textAlign: 'left', ...style }}
      data-vscode-context={vscodeContext}
      aria-current={isFile || undefined}
      tabIndex={isFile ? undefined : 0}
      onClick={isFile ? undefined : onOpen}
      onKeyDown={e => {
        if (!isFile && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen();
        }
      }}
      title={[o.plugin, o.origin, ...(status ? [...(collapsed ? [status.label] : []), status.reason] : [])].join('\n')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span onClick={e => e.stopPropagation()}><ExpandArrow expanded={!collapsed} onToggle={onToggleCollapse} /></span>
        {isFile && <span className="codicon codicon-edit" aria-hidden />}
        <div>
          {collapsed
            ? o.loadIndex != null && `[${o.loadIndex}]`
            : <>{o.loadIndex != null && `[${o.loadIndex}] `}<span>{o.plugin}</span></>}
        </div>
      </div>
      {!collapsed && (
        <>
          {status && <div style={{ marginTop: 3, fontSize: '10px', opacity: 0.55, fontStyle: 'italic' }}>{status.label}</div>}
          <ColumnEdge onResize={onResize} />
        </>
      )}
    </th>
  );
}
