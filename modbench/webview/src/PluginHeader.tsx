import React from 'react';
import type { CompareOverride } from './types';
import { columnStatus, type ColumnStatus } from './recordUtils';

interface PluginHeaderProps {
  override: CompareOverride;
  isImmutable: boolean;
  // ADR-0007: checked after isImmutable — an immutable plugin's read-only-ness is not something
  // tracking can lift, so its own reason wins.
  isTracked: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  // The already-combined `data-vscode-context` JSON string VS Code's own
  // `contributes.menus["webview/context"]` gates the header's Copy Into… commands on, computed by
  // the caller rather than derived here.
  vscodeContext?: string;
  // ADR-0007: the record editor has one write path, so this component only reports the gesture.
  // The header write is what clears the flag, so it cannot be gated on the state it exists to
  // change.
  onTogglePartialForm: (next: boolean) => void;
}

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
  // editor.md, Columns, A column's header, Status table: Overwrite's own row, worded as the
  // table's tooltip column states it, naming no gesture this header's menu lacks.
  inOverwrite: {
    label: '(in Overwrite)',
    title: 'Overwrite is not a mod, and a plugin moved into a mod can be tracked.',
  },
  // The friction is deliberate (ADR-0007): editing someone else's plugin is the community's
  // anti-pattern. The label still says it is one command deep — a read-only column with no stated
  // way out reads as a defect.
  untracked: {
    label: '(untracked)',
    title:
      'This plugin is not tracked, so its records are read-only. '
      + '\u201cTrack Mod\u2026\u201d, or \u201cDecompile Plugin\u201d in a tracked mod, in this header\u2019s menu '
      + 'makes it editable \u2014 its records become text in the mod\u2019s own git repository, and your edits show up in Source Control.',
  },
  tracked: {
    label: '(tracked)',
    title: 'This plugin\u2019s mod is tracked \u2014 its records are editable, and your edits show up in Source Control.',
  },
};

// ADR-0008: nothing may declare a master directly — the masters field renders through the
// ordinary compare-grid rows, read-only. The text quotes CONTEXT.md's Partial Form glossary entry
// rather than paraphrasing it.
const PARTIAL_FORM_TITLE =
  'Partial Form: marks an override that exists only to carry children. Its own fields are ignored '
  + 'for conflict resolution and read-only here except this checkbox — clear it to make the '
  + 'record’s own fields editable again.';

export function PluginHeader({
  override: o, isImmutable, isTracked, collapsed, onToggleCollapse,
  vscodeContext, onTogglePartialForm,
}: PluginHeaderProps) {
  const status = columnStatus(isImmutable, isTracked, o.parseDiagnosis, o.isInOverwrite);
  // Parse failure's reason ends with this column's own diagnosis, so it is composed rather than
  // tabled. Every other state's reason is the table's alone.
  const title = STATUS_TEXT[status].title + (o.parseDiagnosis == null ? '' : ` ${o.parseDiagnosis}`);
  // A column that is not plainly tracked offers no write that could land, so the checkbox is
  // disabled (never hidden — the current state must stay visible) rather than a silent dead control.
  const canWrite = status === 'tracked';
  return (
    <div data-vscode-context={vscodeContext}>
      {/* Left-click the plugin-name chip collapses/expands this column. ADR-0012 invariant 3:
          origin is never what the user reads; it sits in the tooltip. */}
      <div
        onClick={onToggleCollapse}
        style={{ cursor: 'pointer' }}
        title={`Origin: ${o.origin}`}
      >
        [{o.loadIndex}] <span>{o.plugin}</span>
      </div>
      {!collapsed && (
        <>
          <div style={{ fontWeight: 400, opacity: 0.6, fontSize: '11px' }}>
            {o.isWinner ? '✓ winner' : ''}
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
