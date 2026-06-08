import React, { useState } from 'react';
import { toStr } from './recordUtils';
import type { FieldMetadata } from './types';

const mono = 'var(--vscode-editor-font-family, "Consolas", monospace)';
const fg   = 'var(--vscode-editor-foreground, #ccc)';
const borderColor = 'var(--vscode-editorGroup-border, #444)';

interface StructRowGroupProps {
  value: Record<string, unknown> | null | undefined;
  meta: FieldMetadata;
  editMode: boolean;
  port: number;
  onOpen: (fk: string) => void;
  onCommit: (v: Record<string, unknown>) => void;
  storageKey: string;
}

export function StructRowGroup({ value, meta, editMode, port, onOpen, onCommit, storageKey }: StructRowGroupProps) {
  const stored = sessionStorage.getItem(storageKey);
  const [expanded, setExpanded] = useState(stored === 'true');

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    sessionStorage.setItem(storageKey, String(next));
  }

  const fields = meta.fields ?? [];
  const obj: Record<string, unknown> = value != null && typeof value === 'object' ? value : {};

  const toggleStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--vscode-textLink-foreground, #3794ff)',
    fontFamily: mono,
    fontSize: '12px',
    padding: 0,
  };

  if (!expanded) {
    return (
      <button onClick={toggle} style={toggleStyle}>{'{…}'}</button>
    );
  }

  function commitSubField(fieldName: string, fieldValue: unknown) {
    onCommit({ ...obj, [fieldName]: fieldValue });
  }

  return (
    <div>
      <button onClick={toggle} style={{ ...toggleStyle, marginBottom: 4 }}>{'{–}'}</button>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {fields.map(f => {
            const cellValue = obj[f.name] ?? null;
            return (
              <tr key={f.name}>
                <td style={{
                  fontFamily: mono, fontSize: '11px', opacity: 0.7,
                  paddingRight: 6, whiteSpace: 'nowrap', color: fg,
                  border: `1px solid ${borderColor}`, padding: '2px 6px',
                }}>
                  {f.name}
                </td>
                <td style={{ border: `1px solid ${borderColor}`, padding: '2px 6px', minWidth: 120 }}>
                  {renderSubCell(cellValue, f, editMode, port, onOpen,
                    v => commitSubField(f.name, v), `${storageKey}:${f.name}`)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Lazy import to avoid circular dependency with RecordPanel
function renderSubCell(
  value: unknown,
  meta: FieldMetadata,
  editMode: boolean,
  port: number,
  onOpen: (fk: string) => void,
  onCommit: (v: unknown) => void,
  storageKey: string,
): React.ReactNode {
  // Inline minimal scalar rendering to avoid circular imports.
  // Full ScalarCell / FormKeyCell integration happens in RecordPanel's renderCell.
  if (meta.type === 'struct' && meta.fields) {
    return (
      <StructRowGroup
        value={value as Record<string, unknown>}
        meta={meta} editMode={editMode} port={port}
        onOpen={onOpen}
        onCommit={v => onCommit(v)}
        storageKey={storageKey}
      />
    );
  }
  if (meta.type === 'array') {
    // Avoid circular import: arrays inside structs render as a placeholder for now.
    // Full ArrayRowGroup nesting is handled when StructRowGroup is used from RecordPanel.
    return <span style={{ opacity: 0.5, fontFamily: mono, fontSize: '12px' }}>[…]</span>;
  }
  if (meta.type === 'formKey') {
    const strVal = typeof value === 'string' && value ? value : null;
    if (editMode) {
      return (
        <span style={{ fontFamily: mono, fontSize: '12px', color: fg }}>
          {strVal ?? '—'}
        </span>
      );
    }
    if (!strVal) return <span style={{ opacity: 0.35, fontFamily: mono, fontSize: '12px' }}>—</span>;
    return (
      <button
        onClick={() => onOpen(strVal)}
        style={{
          background: 'none', border: 'none',
          color: 'var(--vscode-textLink-foreground, #3794ff)',
          cursor: 'pointer', fontFamily: mono, fontSize: '12px',
          padding: 0, textDecoration: 'underline',
        }}
      >{strVal}</button>
    );
  }
  // Scalar types
  if (!editMode) {
    return value == null
      ? <span style={{ opacity: 0.35, fontFamily: mono, fontSize: '12px' }}>—</span>
      : <span style={{ fontFamily: mono, fontSize: '12px' }}>{toStr(value)}</span>;
  }
  // Edit mode for scalar
  const inputStyle: React.CSSProperties = {
    fontFamily: mono, fontSize: '12px',
    background: 'var(--vscode-input-background, #3c3c3c)', color: fg,
    border: '1px solid var(--vscode-input-border, #555)',
    padding: '1px 4px', width: '100%', boxSizing: 'border-box',
  };
  if (meta.type === 'bool') {
    return (
      <input type="checkbox"
        checked={value === true}
        onChange={e => onCommit(e.target.checked)} />
    );
  }
  if (meta.type === 'enum' && meta.enumValues.length > 0) {
    return (
      <select value={toStr(value)} style={inputStyle}
        onChange={e => onCommit(e.target.value)}>
        {meta.enumValues.map(ev => <option key={ev}>{ev}</option>)}
      </select>
    );
  }
  const strValue = toStr(value);
  function coerce(s: string): unknown {
    if (meta.type === 'int')   { const n = parseInt(s, 10);   return isNaN(n) ? value : n; }
    if (meta.type === 'float') { const n = parseFloat(s);     return isNaN(n) ? value : n; }
    return s;
  }
  return (
    <input
      type={meta.type === 'int' || meta.type === 'float' ? 'number' : 'text'}
      defaultValue={strValue}
      style={inputStyle}
      onBlur={e => onCommit(coerce(e.target.value))}
      onKeyDown={e => { if (e.key === 'Enter') { onCommit(coerce((e.target as HTMLInputElement).value)); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}
