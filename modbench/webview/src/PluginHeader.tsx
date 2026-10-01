import React from 'react';
import type { CompareOverride } from './types';
import { headerCell } from './gridStyles';
import { ColumnEdge } from './ColumnEdge';

interface PluginHeaderProps {
  override: CompareOverride;
  isImmutable: boolean;
  isTracked: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onResize: (width: number) => void;
  // The column's own styling, shared with its cells so the header and the cells cannot disagree.
  style: React.CSSProperties;
  vscodeContext?: string;
}

interface Status { label: string; reason: string }

// editor.md, A column's header, the Status table: the first row that applies.
function statusOf(o: CompareOverride, isImmutable: boolean, isTracked: boolean): Status {
  if (o.parseDiagnosis != null) return { label: '(parse failure)', reason: o.parseDiagnosis };
  if (isImmutable) return { label: '(read-only)', reason: 'The game’s plugins are not edited.' };
  if (o.isInOverwrite) {
    return {
      label: '(in Overwrite)',
      reason: 'Overwrite is not a mod, and a plugin moved into a mod can be tracked.',
    };
  }
  if (!isTracked) {
    return {
      label: '(untracked)',
      reason: '“Track Mod…”, or “Decompile Plugin” in a tracked mod, in this header’s menu, '
        + 'makes it editable.',
    };
  }
  if (o.isPartialForm) return { label: '(Partial Form)', reason: 'The game ignores this copy’s own fields.' };
  return { label: '(tracked)', reason: 'An edit lands in the mod’s working tree, for review in Source Control.' };
}

export function PluginHeader({
  override: o, isImmutable, isTracked, collapsed, onToggleCollapse, onResize, style, vscodeContext,
}: Readonly<PluginHeaderProps>) {
  const status = statusOf(o, isImmutable, isTracked);

  return (
    <th
      style={{ ...headerCell, position: 'relative', textAlign: 'left', cursor: 'pointer', ...style }}
      data-vscode-context={vscodeContext}
      title={`${o.plugin}\n${o.origin}\n${status.reason}`}
      onClick={onToggleCollapse}
    >
      <div>[{o.loadIndex}] <span>{o.plugin}</span></div>
      {!collapsed && (
        <>
          <div style={{ marginTop: 3, fontSize: '10px', opacity: 0.55, fontStyle: 'italic' }}>{status.label}</div>
          <ColumnEdge onResize={onResize} />
        </>
      )}
    </th>
  );
}
