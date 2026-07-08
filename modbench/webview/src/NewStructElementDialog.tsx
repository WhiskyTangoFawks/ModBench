import React, { useState } from 'react';
import { FormKeyPicker } from './FormKeyPicker';
import { toStr } from './recordUtils';
import type { FieldMetadata } from './types';

const mono = 'var(--vscode-editor-font-family, "Consolas", monospace)';
const fg = 'var(--vscode-editor-foreground, #ccc)';
const borderColor = 'var(--vscode-editorGroup-border, #444)';
const bg = 'var(--vscode-editor-background, #1e1e1e)';

interface NewStructElementDialogProps {
  fields: FieldMetadata[];
  port: number;
  onConfirm: (v: Record<string, unknown>) => void;
  onCancel: () => void;
}

function defaultValue(meta: FieldMetadata): unknown {
  if (meta.type === 'formKey') return null;
  if (meta.type === 'bool') return false;
  if (meta.type === 'int' || meta.type === 'float') return 0;
  if (meta.type === 'enum') return meta.enumValues[0] ?? '';
  if (meta.type === 'array') return [];
  if (meta.type === 'struct') return {};
  return '';
}

const inputStyle: React.CSSProperties = {
  fontFamily: mono, fontSize: '12px',
  background: 'var(--vscode-input-background, #3c3c3c)', color: fg,
  border: '1px solid var(--vscode-input-border, #555)',
  padding: '2px 6px', width: '220px', boxSizing: 'border-box', textAlign: 'left',
};

export function NewStructElementDialog({ fields, port, onConfirm, onCancel }: NewStructElementDialogProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of fields) init[f.name] = defaultValue(f);
    return init;
  });
  const [pickingField, setPickingField] = useState<string | null>(null);

  function setField(name: string, v: unknown) {
    setValues(prev => ({ ...prev, [name]: v }));
  }

  function renderInput(f: FieldMetadata): React.ReactNode {
    if (f.type === 'formKey') {
      if (pickingField === f.name) {
        return (
          <FormKeyPicker
            port={port}
            validTypes={f.validFormKeyTypes}
            onSelect={fk => { setField(f.name, fk); setPickingField(null); }}
            onClose={() => setPickingField(null)}
          />
        );
      }
      const v = values[f.name];
      return (
        <button onClick={() => setPickingField(f.name)} style={inputStyle}>
          {typeof v === 'string' && v ? v : <span style={{ opacity: 0.5 }}>— click to pick</span>}
        </button>
      );
    }
    if (f.type === 'bool') {
      return (
        <input
          type="checkbox"
          checked={values[f.name] === true}
          onChange={e => setField(f.name, e.target.checked)}
        />
      );
    }
    if (f.type === 'enum') {
      return (
        <select
          value={toStr(values[f.name])}
          style={inputStyle}
          onChange={e => setField(f.name, e.target.value)}
        >
          {f.enumValues.map(ev => <option key={ev}>{ev}</option>)}
        </select>
      );
    }
    if (f.type === 'struct' || f.type === 'array') {
      return <span style={{ opacity: 0.5, fontFamily: mono, fontSize: '12px' }}>{f.type === 'array' ? '[…]' : '{…}'}</span>;
    }
    return (
      <input
        type={f.type === 'int' || f.type === 'float' ? 'number' : 'text'}
        defaultValue={toStr(values[f.name])}
        style={inputStyle}
        onChange={e => {
          const s = e.target.value;
          if (f.type === 'int') { const n = parseInt(s, 10); setField(f.name, Number.isNaN(n) ? 0 : n); return; }
          if (f.type === 'float') { const n = parseFloat(s); setField(f.name, Number.isNaN(n) ? 0 : n); return; }
          setField(f.name, s);
        }}
      />
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: bg, border: `1px solid ${borderColor}`,
        padding: 12, minWidth: 280,
      }}>
        <div style={{ fontFamily: mono, fontSize: '12px', marginBottom: 8, color: fg }}>Add element</div>
        <table style={{ borderCollapse: 'collapse' }}>
          <tbody>
            {fields.map(f => (
              <tr key={f.name}>
                <td style={{
                  fontFamily: mono, fontSize: '11px', opacity: 0.7, color: fg,
                  paddingRight: 6, whiteSpace: 'nowrap', verticalAlign: 'top', paddingTop: 4,
                }}>
                  {f.name}
                </td>
                <td style={{ padding: '2px 0' }}>
                  {renderInput(f)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button
            onClick={onCancel}
            style={{
              fontSize: '11px', padding: '2px 8px', cursor: 'pointer',
              background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
              color: 'var(--vscode-button-secondaryForeground, #ccc)',
              border: '1px solid var(--vscode-button-secondaryHoverBackground, #45494e)',
            }}
          >Cancel</button>
          <button
            onClick={() => onConfirm(values)}
            style={{
              fontSize: '11px', padding: '2px 8px', cursor: 'pointer',
              background: 'var(--vscode-button-background, #0e639c)',
              color: 'var(--vscode-button-foreground, #fff)',
              border: 'none',
            }}
          >Add</button>
        </div>
      </div>
    </div>
  );
}
