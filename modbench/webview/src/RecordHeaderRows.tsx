import React, { useRef, useState } from 'react';
import { DiskCell } from './DiskCell';
import { formKeyLabel } from './FormKeyLink';
import { ExpandArrow } from './ExpandArrow';
import { baseCell, labelCell, focusedRowStyle, mono, fg } from './gridStyles';
import { toStr, type Column } from './recordUtils';
import { WrittenValue } from './WrittenValue';
import type { WriteAt } from './unconfirmedWrites';
import type { FocusedCell } from './DiffRow';
import type { ColumnKey, PathHop } from './types';
import { LABEL_COLUMN } from './columnKey';

export const RECORD_HEADER_ROW = 'Record Header';
export const FORM_ID_ROW = `${RECORD_HEADER_ROW}.FormID`;
// An edit of the FormID names the document member a record's FormID is (editor.md, The FormID).
export const FORM_ID_PATH: PathHop[] = [{ kind: 'member', name: 'FormKey' }];
const INDENT = 24;

interface FormIdCellProps {
  formKey: string;
  label: string;
  editable: boolean;
  onCommit: (formKey: string) => void;
}

// xEdit's FormID reads as the record it names, and edits as the ID typed; mEdit spells both as
// the FormKey (xedit.md, divergence 12).
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

interface RecordHeaderRowsProps {
  columns: Column[];
  collapsedColumns: Set<ColumnKey>;
  columnStyle: (column: ColumnKey | typeof LABEL_COLUMN) => React.CSSProperties;
  editableColumns: Set<ColumnKey>;
  expanded: boolean;
  onToggle: () => void;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey | null) => void;
  onCommitFormId: (plugin: ColumnKey, formKey: string) => void;
  writeAt: WriteAt;
}

/** editor.md, The FormID: the grid's first rows, Record Header and the record's FormID under it,
 *  each column reading its own copy's FormKey. */
export function RecordHeaderRows({
  columns, collapsedColumns, columnStyle, editableColumns, expanded, onToggle,
  focusedCell, onFocusCell, onCommitFormId, writeAt,
}: Readonly<RecordHeaderRowsProps>) {
  const cellStyle = (key: ColumnKey): React.CSSProperties =>
    ({ ...baseCell, ...columnStyle(key) });
  const rowStyle = (rowKey: string) => (focusedCell?.rowKey === rowKey ? focusedRowStyle : undefined);
  const isFocused = (rowKey: string, key: ColumnKey | null) => focusedCell?.rowKey === rowKey && focusedCell.plugin === key;

  return (
    <>
      <tr style={rowStyle(RECORD_HEADER_ROW)}>
        <DiskCell
          style={labelCell(columnStyle(LABEL_COLUMN))} isFocused={isFocused(RECORD_HEADER_ROW, null)}
          onFocusCell={() => onFocusCell(RECORD_HEADER_ROW, null)} onDoubleClick={onToggle}
        >
          <ExpandArrow expanded={expanded} onToggle={onToggle} />
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
            style={{ ...labelCell(columnStyle(LABEL_COLUMN)), paddingLeft: INDENT }} isFocused={isFocused(FORM_ID_ROW, null)}
            onFocusCell={() => onFocusCell(FORM_ID_ROW, null)}
          >FormID</DiskCell>
          {columns.map(({ key, override }) => collapsedColumns.has(key)
            ? <td key={key} style={cellStyle(key)} />
            : (
              <DiskCell
                key={key} style={cellStyle(key)} isFocused={isFocused(FORM_ID_ROW, key)}
                onFocusCell={() => onFocusCell(FORM_ID_ROW, key)}
                title={override.formIdReadOnlyReason ?? undefined}
                copyText={formKeyLabel(override.formKey, override)}
              >
                <WrittenValue write={writeAt(key, FORM_ID_PATH)} disk={override.formKey}>
                  {value => (
                    <FormIdCell
                      formKey={toStr(value)}
                      // A FormKey the disk does not hold yet names no record.
                      label={value === override.formKey ? formKeyLabel(override.formKey, override) : toStr(value)}
                      editable={editableColumns.has(key) && override.formIdReadOnlyReason == null}
                      onCommit={formKey => onCommitFormId(key, formKey)}
                    />
                  )}
                </WrittenValue>
              </DiskCell>
            ))}
        </tr>
      )}
    </>
  );
}
