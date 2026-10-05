import React, { useRef, useState } from 'react';
import { DiskCell } from './DiskCell';
import { formKeyLabel } from './FormKeyLink';
import { ExpandArrow } from './ExpandArrow';
import { baseCell, labelCell, focusedRowStyle, mono, fg } from './gridStyles';
import type { Column } from './recordUtils';
import type { FocusedCell } from './DiffRow';
import type { ColumnKey, PathHop } from './types';
import { LABEL_COLUMN } from './columnKey';

export const RECORD_HEADER_ROW = 'Record Header';
export const FORM_ID_ROW = `${RECORD_HEADER_ROW}.FormID`;
// The document member a record's FormID is (editor.md, The record header, story 2).
export const FORM_ID_PATH: PathHop[] = [{ kind: 'member', name: 'FormKey' }];
const INDENT = 24;

interface FormIdCellProps {
  formKey: string;
  label: string;
  editable: boolean;
  onCommit: (formKey: string) => void;
}

// xEdit's FormID reads as the record it names, and edits as the ID typed; mEdit spells both as
// the FormKey (xedit.md, divergence 16).
function FormIdCell({ formKey, label, editable, onCommit }: Readonly<FormIdCellProps>) {
  const [draft, setDraft] = useState<string | null>(null);
  const settled = useRef(true);
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

interface RecordHeaderRowProps {
  columns: Column[];
  collapsedColumns: Set<ColumnKey>;
  columnStyle: (column: ColumnKey | typeof LABEL_COLUMN) => React.CSSProperties;
  expanded: boolean;
  onToggle: () => void;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey | null) => void;
}

const isFocused = (focusedCell: FocusedCell | null, rowKey: string, key: ColumnKey | null) =>
  focusedCell?.rowKey === rowKey && focusedCell.plugin === key;
const rowStyle = (focusedCell: FocusedCell | null, rowKey: string) =>
  (focusedCell?.rowKey === rowKey ? focusedRowStyle : undefined);

/** editor.md, The record header: the grid's first row, which the header members sit under. */
export function RecordHeaderRow({
  columns, collapsedColumns, columnStyle, expanded, onToggle, focusedCell, onFocusCell,
}: Readonly<RecordHeaderRowProps>) {
  const cellStyle = (key: ColumnKey): React.CSSProperties => ({ ...baseCell, ...columnStyle(key) });
  return (
    <tr style={rowStyle(focusedCell, RECORD_HEADER_ROW)}>
      <DiskCell
        style={labelCell(columnStyle(LABEL_COLUMN))} isFocused={isFocused(focusedCell, RECORD_HEADER_ROW, null)}
        onFocusCell={() => onFocusCell(RECORD_HEADER_ROW, null)} onDoubleClick={onToggle}
        copyText={RECORD_HEADER_ROW}
      >
        <ExpandArrow expanded={expanded} onToggle={onToggle} />
        {RECORD_HEADER_ROW}
      </DiskCell>
      {columns.map(({ key }) => collapsedColumns.has(key)
        ? <td key={key} style={cellStyle(key)} />
        : (
          <DiskCell
            key={key} style={cellStyle(key)} isFocused={isFocused(focusedCell, RECORD_HEADER_ROW, key)}
            onFocusCell={() => onFocusCell(RECORD_HEADER_ROW, key)}
          >
            {!expanded && <span style={{ opacity: 0.5 }}>{'{…}'}</span>}
          </DiskCell>
        ))}
    </tr>
  );
}

interface FormIdRowProps {
  label: string;
  readOnlyReason: string | null | undefined;
  columns: Column[];
  collapsedColumns: Set<ColumnKey>;
  columnStyle: (column: ColumnKey | typeof LABEL_COLUMN) => React.CSSProperties;
  editableColumns: Set<ColumnKey>;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey | null) => void;
  onCommitFormId: (plugin: ColumnKey, formKey: string) => void;
}

/** editor.md, The record header, story 2: each column reads its own copy's FormKey. */
export function FormIdRow({
  label, readOnlyReason, columns, collapsedColumns, columnStyle, editableColumns, focusedCell, onFocusCell, onCommitFormId,
}: Readonly<FormIdRowProps>) {
  const cellStyle = (key: ColumnKey): React.CSSProperties => ({ ...baseCell, ...columnStyle(key) });
  return (
    <tr style={rowStyle(focusedCell, FORM_ID_ROW)}>
      <DiskCell
        style={{ ...labelCell(columnStyle(LABEL_COLUMN)), paddingLeft: INDENT }} isFocused={isFocused(focusedCell, FORM_ID_ROW, null)}
        onFocusCell={() => onFocusCell(FORM_ID_ROW, null)} copyText={label}
      >{label}</DiskCell>
      {columns.map(({ key, override }) => collapsedColumns.has(key)
        ? <td key={key} style={cellStyle(key)} />
        : (
          <DiskCell
            key={key} style={cellStyle(key)} isFocused={isFocused(focusedCell, FORM_ID_ROW, key)}
            onFocusCell={() => onFocusCell(FORM_ID_ROW, key)}
            title={readOnlyReason ?? undefined}
            copyText={formKeyLabel(override.formKey, override)}
          >
            <FormIdCell
              formKey={override.formKey}
              label={formKeyLabel(override.formKey, override)}
              editable={editableColumns.has(key) && readOnlyReason == null}
              onCommit={formKey => onCommitFormId(key, formKey)}
            />
          </DiskCell>
        ))}
    </tr>
  );
}
