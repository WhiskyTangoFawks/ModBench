import React from 'react';
import type { RecordDetail } from './types';
import { readOnlyReason } from './recordUtils';
import { DIMMED_OPACITY } from './gridStyles';

interface PluginHeaderProps {
  override: RecordDetail;
  isImmutable: boolean;
  // #304 / ADR-0035: whether the effective load order actually names this copy — distinct from
  // isImmutable (a vanilla master is immutable and still true here; a shadowed copy is immutable
  // *because* this is false). See recordUtils.ts's readOnlyReason for the derivation this
  // component consumes to word its own tooltip and decide whether to dim.
  inLoadOrder: boolean;
  // #304 / ADR-0036: "origin appears inline in the header only when two loaded copies share a
  // filename" — decided by the caller (RecordPanel, via recordUtils.ts's collidingFilenames over
  // the compare response's own overrides), never recomputed here.
  showOriginInline: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

// #304: the on-screen wording for each read-only reason, plus the tooltip that explains it.
// vanillaMaster keeps the pre-existing plain "(read-only)" label — the familiar, common case get
// no noisier. notInLoadOrder gets its own distinct label (AC2: visible, not only discoverable on
// hover) and a tooltip naming ADR-0036's escape hatch. Neither says "mod" or "priority" —
// Editing's own vocabulary is the Plugin load order (CONTEXT-MAP.md's Editing/Mod Management
// boundary forbids "mod"; "priority" is Mod Management's Mod override order, never Editing's).
const READ_ONLY_TEXT: Record<'vanillaMaster' | 'notInLoadOrder', { label: string; title: string }> = {
  vanillaMaster: {
    label: '(read-only)',
    title: 'This is a vanilla, DLC, or Creation Club master and can never be edited.',
  },
  notInLoadOrder: {
    label: '(not in load order)',
    title:
      "This copy is not named by the Plugin load order, so editing it has no effect anywhere. "
      + 'Move it earlier in the load order to make it the copy that loads — it then becomes editable.',
  },
};

// Issue #209: this used to also own "Add Master…" (a button + its own hand-drawn candidate
// dropdown, gated on isHeaderRecord/showMasterPicker/loadedPlugins) — deleted, not adapted, along
// with the rest of the column-header's hand-drawn chrome (ColumnHeaderMenu, PluginTargetPicker).
// Add Master is reachable only via the column header's native right-click menu now (ADR-0033: no
// standalone control once an action is right-click-reachable, same rule #207 applied to the
// inline revert button) — see RecordPanel.tsx's data-vscode-context wiring and
// recordUtils.ts' currentMasters (moved there, since RecordPanel needs it to build that context
// and to compute the appended list when the native command's broadcast comes back in).
export function PluginHeader({
  override: o, isImmutable, inLoadOrder, showOriginInline, collapsed, onToggleCollapse,
}: PluginHeaderProps) {
  const reason = readOnlyReason(isImmutable, inLoadOrder);
  return (
    <div style={reason === 'notInLoadOrder' ? { opacity: DIMMED_OPACITY } : undefined}>
      {/* Issue #3: left-click the plugin-name chip collapses/expands this column. ADR-0036:
          origin is never what the user reads by default — always in the tooltip, inline in the
          label only when a second loaded copy shares this filename (showOriginInline). */}
      <div
        onClick={onToggleCollapse}
        style={{ cursor: 'pointer' }}
        title={`Origin: ${o.origin}`}
      >
        {showOriginInline ? `${o.plugin} (${o.origin})` : o.plugin}
      </div>
      {!collapsed && (
        <>
          <div style={{ fontWeight: 400, opacity: 0.6, fontSize: '11px' }}>
            [{o.loadOrderIndex}]{o.isWinner ? ' ✓ winner' : ''}
          </div>
          {reason && (
            <div
              style={{ marginTop: 3, fontSize: '10px', opacity: 0.55, fontStyle: 'italic' }}
              title={READ_ONLY_TEXT[reason].title}
            >
              {READ_ONLY_TEXT[reason].label}
            </div>
          )}
        </>
      )}
    </div>
  );
}
