import React, { useState } from 'react';
import { DiskCell } from './DiskCell';
import { formKeyLabel } from './FormKeyLink';
import { copyToClipboard } from './nativeBridge';
import { baseCell, toggleBtnStyle, focusedRowStyle, DIMMED_OPACITY, mono, fg } from './gridStyles';
import type { Column } from './recordUtils';
import type { FocusedCell } from './DiffRow';
import type { ColumnKey, CompareOverride } from './types';

export const RECORD_HEADER_ROW = 'Record Header';
const FORM_ID_ROW = `${RECORD_HEADER_ROW}.FormID`;
const INDENT = 24;

interface FormIdCellProps {
  record: CompareOverride;
  editable: boolean;
  isFocused: boolean;
  onCommit: (formKey: string) => void;
}

// xEdit's FormID reads as the record it names, and edits as the ID typed; mEdit spells both as
// the FormKey (xedit.md, divergence 12).
function FormIdCell({ record, editable, isFocused, onCommit }: Readonly<FormIdCellProps>) {
  const { formKey } = record;
  const [draft, setDraft] = useState<string | null>(null);
  const label = formKeyLabel(formKey, record);
  if (!editable) return <span>{label}</span>;
  if (draft === null) {
    return (
      <span
        data-open-trigger
        onClick={() => { if (isFocused) setDraft(formKey); }}
        onDoubleClick={() => setDraft(formKey)}
        style={{ display: 'block', minHeight: '1em' }}
      >
        {label}
      </span>
    );
  }
  return (
    <input
      autoFocus
      type="text"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={e => e.currentTarget.select()}
      onBlur={() => { if (draft !== formKey) onCommit(draft); setDraft(null); }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      style={{
        fontFamily: mono, fontSize: '12px', color: fg, width: '100%', boxSizing: 'border-box',
        background: 'var(--vscode-input-background, #3c3c3c)', border: '1px solid var(--vscode-input-border, #555)',
        padding: '1px 4px',
      }}
    />
  );
}

interface RecordHeaderRowsProps {
  columns: Column[];
  collapsedColumns: Set<ColumnKey>;
  dimmedColumns: Set<ColumnKey>;
  editableColumns: Set<ColumnKey>;
  // A plugin header's FormID names the plugin, and is read-only (editor.md, The FormID).
  isPluginHeader: boolean;
  expanded: boolean;
  onToggle: () => void;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey) => void;
  onCommitFormId: (plugin: ColumnKey, formKey: string) => void;
}

/** editor.md, The FormID: the grid's first rows, Record Header and the record's FormID under it,
 *  each column reading its own copy's FormKey. */
export function RecordHeaderRows({
  columns, collapsedColumns, dimmedColumns, editableColumns, isPluginHeader, expanded, onToggle,
  focusedCell, onFocusCell, onCommitFormId,
}: Readonly<RecordHeaderRowsProps>) {
  const cellStyle = (key: ColumnKey): React.CSSProperties =>
    ({ ...baseCell, opacity: dimmedColumns.has(key) ? DIMMED_OPACITY : undefined });
  const rowStyle = (rowKey: string) => (focusedCell?.rowKey === rowKey ? focusedRowStyle : undefined);
  const isFocused = (rowKey: string, key: ColumnKey) => focusedCell?.rowKey === rowKey && focusedCell.plugin === key;

  return (
    <>
      <tr style={rowStyle(RECORD_HEADER_ROW)}>
        <td style={{ ...baseCell, opacity: 0.75, userSelect: 'text' }} onDoubleClick={onToggle}>
          <button style={toggleBtnStyle} onClick={onToggle}>{expanded ? '▼' : '▶'}</button>
          {RECORD_HEADER_ROW}
        </td>
        {columns.map(({ key }) => collapsedColumns.has(key)
          ? <td key={key} style={cellStyle(key)} />
          : (
            <DiskCell
              key={key} style={cellStyle(key)} isFocused={isFocused(RECORD_HEADER_ROW, key)}
              onFocusCell={() => onFocusCell(RECORD_HEADER_ROW, key)} onCopy={() => undefined}
            >
              {!expanded && <span style={{ opacity: 0.5 }}>{'{…}'}</span>}
            </DiskCell>
          ))}
      </tr>
      {expanded && (
        <tr style={rowStyle(FORM_ID_ROW)}>
          <td style={{ ...baseCell, opacity: 0.75, userSelect: 'text', paddingLeft: INDENT }}>FormID</td>
          {columns.map(({ key, override }) => collapsedColumns.has(key)
            ? <td key={key} style={cellStyle(key)} />
            : (
              <DiskCell
                key={key} style={cellStyle(key)} isFocused={isFocused(FORM_ID_ROW, key)}
                onFocusCell={() => onFocusCell(FORM_ID_ROW, key)}
                onCopy={() => copyToClipboard(formKeyLabel(override.formKey, override))}
              >
                <FormIdCell
                  record={override}
                  editable={!isPluginHeader && editableColumns.has(key)} isFocused={isFocused(FORM_ID_ROW, key)}
                  onCommit={formKey => onCommitFormId(key, formKey)}
                />
              </DiskCell>
            ))}
        </tr>
      )}
    </>
  );
}
