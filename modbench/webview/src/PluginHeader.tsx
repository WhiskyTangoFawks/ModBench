import React from 'react';
import type { CompareOverride } from './types';
import type { UnreadableSource } from '../../src/wire/unreadableSource';
import { headerCell } from './gridStyles';
import { ColumnEdge } from './ColumnEdge';
import { ExpandArrow } from './ExpandArrow';

interface PluginHeaderProps {
  override: CompareOverride;
  overriddenBy: string | null;
  notActive: boolean;
  isImmutable: boolean;
  isTracked: boolean;
  sourceUnreadable: UnreadableSource | undefined;
  isFile: boolean;
  onOpen: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onResize: (width: number) => void;
  // The column's own styling, shared with its cells so the header and the cells cannot disagree.
  style: React.CSSProperties;
  vscodeContext?: string;
}

interface Status { label: string; reason: string }

// editor.md, A column's header, the Status table: the first row that applies.
function statusOf(o: CompareOverride, overriddenBy: string | null, notActive: boolean, isImmutable: boolean, isTracked: boolean, sourceUnreadable: UnreadableSource | undefined): Status {
  if (o.parseDiagnosis != null) return { label: '(parse failure)', reason: o.parseDiagnosis };
  if (overriddenBy !== null) return { label: '(overridden)', reason: `The game loads ${overriddenBy}’s file instead.` };
  if (notActive) return { label: '(not active)', reason: 'The game does not load it, so no other copy is compared.' };
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
  if (sourceUnreadable !== undefined) {
    return {
      label: '(plugin source unreadable)',
      reason: `${sourceUnreadable.reason} Its records are its plugin file’s.`
        + (sourceUnreadable.decompileRepairs ? ' “Decompile Plugin”, in this header’s menu, makes it editable.' : ''),
    };
  }
  if (o.isPartialForm) return { label: '(Partial Form)', reason: 'The game ignores this copy’s own fields.' };
  return { label: '(tracked)', reason: 'An edit lands in the mod’s working tree, for review in Source Control.' };
}

export function PluginHeader({
  override: o, overriddenBy, notActive, isImmutable, isTracked, sourceUnreadable, isFile, onOpen, collapsed, onToggleCollapse, onResize, style, vscodeContext,
}: Readonly<PluginHeaderProps>) {
  const status = statusOf(o, overriddenBy, notActive, isImmutable, isTracked, sourceUnreadable);

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
      title={`${o.plugin}\n${o.origin}\n${status.reason}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span onClick={e => e.stopPropagation()}><ExpandArrow expanded={!collapsed} onToggle={onToggleCollapse} /></span>
        {isFile && <span className="codicon codicon-edit" aria-hidden />}
        <div>[{o.loadIndex}] <span>{o.plugin}</span></div>
      </div>
      {!collapsed && (
        <>
          <div style={{ marginTop: 3, fontSize: '10px', opacity: 0.55, fontStyle: 'italic' }}>{status.label}</div>
          <ColumnEdge onResize={onResize} />
        </>
      )}
    </th>
  );
}
