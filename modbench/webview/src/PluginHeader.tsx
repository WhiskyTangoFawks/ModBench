import React from 'react';
import type { RecordDetail } from './types';
import { columnStatus, type ColumnStatus } from './recordUtils';

interface PluginHeaderProps {
  override: RecordDetail;
  isImmutable: boolean;
  // ADR-0035: whether the effective load order names this copy — distinct from isImmutable (a
  // shadowed copy is immutable *because* this is false). Dimming is applied once at the header
  // cell; CSS opacity multiplies on nesting.
  inLoadOrder: boolean;
  // ADR-0041: checked after the two flags above — an immutable plugin's read-only-ness is not
  // something tracking can lift, so its own reason wins.
  isTracked: boolean;
  // ADR-0036: origin appears inline in the header only when two copies share a filename — decided
  // by the caller over the compare response's own overrides, never recomputed here.
  showOriginInline: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  // The already-combined `data-vscode-context` JSON string VS Code's own
  // `contributes.menus["webview/context"]` gates the header's Copy Into… commands on, computed by
  // the caller rather than derived here.
  vscodeContext?: string;
  // ADR-0041: the record editor has one write path, so this component only reports the gesture.
  // The header write is what clears the flag, so it cannot be gated on the state it exists to
  // change.
  onTogglePartialForm: (next: boolean) => void;
}

// The tooltip must not advise moving this copy in the load order — wrong axis: a shadowed copy is
// a file conflict, decided by the Mod override order and not by `plugins.txt`.

// A column marked `!inLoadOrder` may be shadowed *or* be a plugin file `plugins.txt` never lists;
// the wire carries no signal telling them apart, so the wording must be true for both.
const STATUS_TEXT: Record<ColumnStatus, { label: string; title: string }> = {
  // The record's own diagnosis is appended as the rest of this reason, so the sentence has to end
  // where the diagnosis begins. No way out is named: repairing the record is not offered anywhere.
  parseFailure: {
    label: '(parse failure)',
    title:
      'This record could not be read when its plugin was indexed, so this column shows only what '
      + 'could be stored of it and nothing in it can be edited. The reason it could not be read:',
  },
  vanillaMaster: {
    label: '(read-only)',
    title:
      'This is a vanilla, DLC, or Creation Club master and can never be edited. '
      + 'To change what it defines, author a patch plugin holding the override and edit that.',
  },
  notInLoadOrder: {
    label: '(not loaded)',
    title:
      'This copy plays no part in what the game actually loads, so editing it here changes '
      + 'nothing anywhere. Whether this file loads, and which copy, is decided in the Mods and '
      + 'Plugins views.',
  },
  // The friction is deliberate (ADR-0041): editing someone else's plugin is the community's
  // anti-pattern. The label still says it is one command deep — a read-only column with no stated
  // way out reads as a defect.
  untracked: {
    label: '(untracked)',
    title:
      'This plugin\u2019s mod is not tracked, so its records are read-only. '
      + 'Run \u201cModbench: Track\u2026\u201d on it once to start editing \u2014 '
      + 'its records become text in the mod\u2019s own git repository, and your edits show up in Source Control.',
  },
  tracked: {
    label: '(tracked)',
    title: 'This plugin\u2019s mod is tracked \u2014 its records are editable, and your edits show up in Source Control.',
  },
};

// ADR-0038: nothing may declare a master directly — the masters field renders through the
// ordinary compare-grid rows, read-only. The text quotes CONTEXT.md's Partial Form glossary entry
// rather than paraphrasing it.
const PARTIAL_FORM_TITLE =
  'Partial Form: marks an override that exists only to carry children. Its own fields are ignored '
  + 'for conflict resolution and read-only here except this checkbox — clear it to make the '
  + 'record’s own fields editable again.';

export function PluginHeader({
  override: o, isImmutable, inLoadOrder, isTracked, showOriginInline, collapsed, onToggleCollapse,
  vscodeContext, onTogglePartialForm,
}: PluginHeaderProps) {
  const status = columnStatus(isImmutable, inLoadOrder, isTracked, o.parseDiagnosis);
  // Parse failure's reason ends with this column's own diagnosis, so it is composed rather than
  // tabled. Every other state's reason is the table's alone.
  const title = STATUS_TEXT[status].title + (o.parseDiagnosis == null ? '' : ` ${o.parseDiagnosis}`);
  // A column that is not plainly tracked and in the load order offers no write that could land,
  // so the checkbox is disabled (never hidden — the current state must stay visible) rather than
  // a silent dead control.
  const canWrite = status === 'tracked' && inLoadOrder;
  return (
    <div data-vscode-context={vscodeContext}>
      {/* Left-click the plugin-name chip collapses/expands this column. ADR-0036:
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
          <div
            style={{ marginTop: 3, fontSize: '10px', opacity: 0.55, fontStyle: 'italic' }}
            title={title}
          >
            {STATUS_TEXT[status].label}
          </div>
          {o.isPartialFormable && (
            <label
              style={{ display: 'block', marginTop: 3, fontSize: '10px', opacity: 0.85 }}
              title={PARTIAL_FORM_TITLE}
            >
              <input
                type="checkbox"
                checked={o.isPartialForm}
                disabled={!canWrite}
                onChange={e => onTogglePartialForm(e.target.checked)}
              />
              {' '}Partial Form
            </label>
          )}
        </>
      )}
    </div>
  );
}
