import React, { useState } from 'react';
import { StructRowGroup } from './StructRowGroup';
import { NewStructElementDialog } from './NewStructElementDialog';
import { toStr } from './recordUtils';
import type { FieldMetadata } from './types';

const mono = 'var(--vscode-editor-font-family, "Consolas", monospace)';
const fg   = 'var(--vscode-editor-foreground, #ccc)';
const borderColor = 'var(--vscode-editorGroup-border, #444)';

interface ArrayRowGroupProps {
  value: unknown[] | null | undefined;
  meta: FieldMetadata;
  editMode: boolean;
  port: number;
  onOpen: (fk: string) => void;
  onCommit: (v: unknown[]) => void;
  storageKey: string;
  checkError?: string | null;
}

export function ArrayRowGroup({ value, meta, editMode, port, onOpen, onCommit, storageKey, checkError }: ArrayRowGroupProps) {
  const stored = sessionStorage.getItem(storageKey);
  const [expanded, setExpanded] = useState(stored === 'true');
  const [addingElement, setAddingElement] = useState(false);
  const items: unknown[] = Array.isArray(value) ? value : [];
  const elemMeta = meta.elementType;

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    sessionStorage.setItem(storageKey, String(next));
  }

  function handleSort() {
    const sorted = [...items].sort((a, b) =>
      toStr(a).localeCompare(toStr(b), undefined, { sensitivity: 'base' })
    );
    onCommit(sorted);
  }

  function handleAdd() {
    if (elemMeta?.type === 'struct' && elemMeta.fields) {
      setAddingElement(true);
      return;
    }
    onCommit([...items, null]);
  }

  function handleConfirmAdd(newElement: Record<string, unknown>) {
    setAddingElement(false);
    onCommit([...items, newElement]);
  }

  function handleRemove(idx: number) {
    onCommit(items.filter((_, i) => i !== idx));
  }

  function handleElementCommit(idx: number, v: unknown) {
    const next = [...items];
    next[idx] = v;
    onCommit(next);
  }

  const linkStyle: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--vscode-textLink-foreground, #3794ff)',
    fontFamily: mono, fontSize: '12px', padding: 0,
  };
  const btnStyle: React.CSSProperties = {
    fontSize: '10px', padding: '0 4px', marginLeft: 4, cursor: 'pointer',
    background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
    color: 'var(--vscode-button-secondaryForeground, #ccc)',
    border: '1px solid var(--vscode-button-secondaryHoverBackground, #45494e)',
    borderRadius: 2,
  };

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <button onClick={toggle} style={linkStyle}>{`[${items.length}]`}</button>
      {checkError && (
        <span
          title={checkError}
          style={{ color: 'var(--vscode-errorForeground, #f88)', fontSize: '11px', cursor: 'default' }}
        >⚠</span>
      )}
      {editMode && elemMeta?.isSortable && (
        <button onClick={handleSort} title="Sort by FormKey" style={btnStyle}>↑↓</button>
      )}
      {editMode && (
        <button onClick={handleAdd} title="Add element" style={btnStyle}>+</button>
      )}
    </div>
  );

  const dialog = addingElement && elemMeta?.fields ? (
    <NewStructElementDialog
      fields={elemMeta.fields}
      port={port}
      onConfirm={handleConfirmAdd}
      onCancel={() => setAddingElement(false)}
    />
  ) : null;

  if (!expanded) return <>{header}{dialog}</>;

  return (
    <div>
      {header}
      {dialog}
      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 4 }}>
        <tbody>
          {items.map((item, idx) => (
            <tr key={idx}>
              <td style={{
                fontFamily: mono, fontSize: '11px', opacity: 0.5,
                border: `1px solid ${borderColor}`, padding: '2px 4px',
                userSelect: 'none', width: 28,
              }}>
                {idx}
              </td>
              <td style={{ border: `1px solid ${borderColor}`, padding: '2px 6px' }}>
                {renderElement(item, idx, elemMeta, editMode, port, onOpen,
                  v => handleElementCommit(idx, v), storageKey)}
              </td>
              {editMode && (
                <td style={{ border: `1px solid ${borderColor}`, padding: '2px 4px', width: 20 }}>
                  <button
                    onClick={() => handleRemove(idx)}
                    title="Remove element"
                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--vscode-errorForeground, #f88)', fontSize: '11px', padding: 0 }}
                  >✕</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderElement(
  item: unknown,
  idx: number,
  elemMeta: FieldMetadata | undefined,
  editMode: boolean,
  port: number,
  onOpen: (fk: string) => void,
  onCommit: (v: unknown) => void,
  parentKey: string,
): React.ReactNode {
  if (!elemMeta) {
    return <span style={{ fontFamily: mono, fontSize: '12px', color: fg }}>{toStr(item)}</span>;
  }

  if (elemMeta.type === 'struct') {
    return (
      <StructRowGroup
        value={item as Record<string, unknown>}
        meta={elemMeta} editMode={editMode} port={port}
        onOpen={onOpen}
        onCommit={v => onCommit(v)}
        storageKey={`${parentKey}:${idx}`}
      />
    );
  }

  if (elemMeta.type === 'formKey') {
    const strVal = typeof item === 'string' && item ? item : null;
    if (editMode) {
      const inputStyle: React.CSSProperties = {
        fontFamily: mono, fontSize: '12px',
        background: 'var(--vscode-input-background, #3c3c3c)', color: fg,
        border: '1px solid var(--vscode-input-border, #555)',
        padding: '1px 4px', width: '100%', boxSizing: 'border-box',
      };
      return (
        <input type="text" defaultValue={strVal ?? ''}
          style={inputStyle}
          onBlur={e => onCommit(e.target.value || null)}
          onKeyDown={e => { if (e.key === 'Enter') { onCommit((e.target as HTMLInputElement).value || null); (e.target as HTMLInputElement).blur(); } }}
        />
      );
    }
    if (!strVal) return <span style={{ opacity: 0.35, fontFamily: mono, fontSize: '12px' }}>—</span>;
    return (
      <button onClick={() => onOpen(strVal)} style={{
        background: 'none', border: 'none',
        color: 'var(--vscode-textLink-foreground, #3794ff)',
        cursor: 'pointer', fontFamily: mono, fontSize: '12px',
        padding: 0, textDecoration: 'underline',
      }}>{strVal}</button>
    );
  }

  // Scalar fallback
  if (!editMode) {
    return item == null
      ? <span style={{ opacity: 0.35, fontFamily: mono, fontSize: '12px' }}>—</span>
      : <span style={{ fontFamily: mono, fontSize: '12px' }}>{toStr(item)}</span>;
  }
  const inputStyle: React.CSSProperties = {
    fontFamily: mono, fontSize: '12px',
    background: 'var(--vscode-input-background, #3c3c3c)', color: fg,
    border: '1px solid var(--vscode-input-border, #555)',
    padding: '1px 4px', width: '100%', boxSizing: 'border-box',
  };
  function coerce(s: string): unknown {
    if (elemMeta.type === 'int')   { const n = parseInt(s, 10);   return isNaN(n) ? item : n; }
    if (elemMeta.type === 'float') { const n = parseFloat(s);     return isNaN(n) ? item : n; }
    return s;
  }
  return (
    <input
      type={elemMeta.type === 'int' || elemMeta.type === 'float' ? 'number' : 'text'}
      defaultValue={toStr(item)}
      style={inputStyle}
      onBlur={e => onCommit(coerce(e.target.value))}
      onKeyDown={e => { if (e.key === 'Enter') { onCommit(coerce((e.target as HTMLInputElement).value)); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}
