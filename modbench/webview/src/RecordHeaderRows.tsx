import React, { useRef, useState } from 'react';
import { DiskCell } from './DiskCell';
import { formKeyLabel } from './FormKeyLink';
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
  onCommit: (formKey: string) => void;
}

// xEdit's FormID reads as the record it names, and edits as the ID typed; mEdit spells both as
// the FormKey (xedit.md, divergence 12).
function FormIdCell({ record, editable, onCommit }: Readonly<FormIdCellProps>) {
  const { formKey } = record;
  const [draft, setDraft] = useState<string | null>(null);
  const settled = useRef(true);
  const label = formKeyLabel(formKey, record);
  if (!editable) return <span>{label}</span>;
  function settle(write: boolean) {
    if (settled.current) return;
    settled.current = true;
    if (write && draft !== null && draft !== formKey) onCommit(draft);
    setDraft(null);
  }
  if (draft === null) {
    return (
      <span
        data-open-trigger
        onClick={() => { settled.current = false; setDraft(formKey); }}
        style={{ display: 'block', minHeight: '1em' }}
      >
        {label}
      </span>
    );
  }
  return (
    <input
      data-editor
      autoFocus
      type="text"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={e => e.currentTarget.select()}
      onBlur={() => settle(true)}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        const cell = e.currentTarget.closest('td');
        settle(e.key === 'Enter');
        cell?.focus();
      }}
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
  onFocusCell: (rowKey: string, plugin: ColumnKey | null) => void;
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
  const isFocused = (rowKey: string, key: ColumnKey | null) => focusedCell?.rowKey === rowKey && focusedCell.plugin === key;

  return (
    <>
      <tr style={rowStyle(RECORD_HEADER_ROW)}>
        <DiskCell
          style={{ ...baseCell, opacity: 0.75 }} isFocused={isFocused(RECORD_HEADER_ROW, null)}
          onFocusCell={() => onFocusCell(RECORD_HEADER_ROW, null)} onDoubleClick={onToggle}
        >
          <button style={toggleBtnStyle} onClick={onToggle}>{expanded ? '▼' : '▶'}</button>
          {RECORD_HEADER_ROW}
        </DiskCell>
        {columns.map(({ key }) => collapsedColumns.has(key)
          ? <td key={key} style={cellStyle(key)} />
          : (
            <DiskCell
              key={key} style={cellStyle(key)} isFocused={isFocused(RECORD_HEADER_ROW, key)}
              onFocusCell={() => onFocusCell(RECORD_HEADER_ROW, key)}
            >
              {!expanded && <span style={{ opacity: 0.5 }}>{'{…}'}</span>}
            </DiskCell>
          ))}
      </tr>
      {expanded && (
        <tr style={rowStyle(FORM_ID_ROW)}>
          <DiskCell
            style={{ ...baseCell, opacity: 0.75, paddingLeft: INDENT }} isFocused={isFocused(FORM_ID_ROW, null)}
            onFocusCell={() => onFocusCell(FORM_ID_ROW, null)}
          >FormID</DiskCell>
          {columns.map(({ key, override }) => collapsedColumns.has(key)
            ? <td key={key} style={cellStyle(key)} />
            : (
              <DiskCell
                key={key} style={cellStyle(key)} isFocused={isFocused(FORM_ID_ROW, key)}
                onFocusCell={() => onFocusCell(FORM_ID_ROW, key)}
                copyText={formKeyLabel(override.formKey, override)}
              >
                <FormIdCell
                  record={override}
                  editable={!isPluginHeader && editableColumns.has(key)}
                  onCommit={formKey => onCommitFormId(key, formKey)}
                />
              </DiskCell>
            ))}
        </tr>
      )}
    </>
  );
}
