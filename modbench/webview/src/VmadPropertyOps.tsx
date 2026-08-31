import React, { useState } from 'react';
import { fg, mono } from './gridStyles';
import { pickFormKey } from './nativeBridge';
import { ModalShell } from './ModalShell';
import { ADDABLE_TYPES, defaultOpValue, opScalarKind } from './vmadOps';

// Add Property's dialog — the "one deliberate exception" to native prompts (three fields at
// once, a webview modal rather than a QuickPick chain, see ModalShell.tsx), reached from the
// right-click menu's VMAD_OPEN_ADD_PROPERTY broadcast (RecordPanel.tsx). Structural ops are
// right-click-menu-only (ADR-0034's no-second-route rule, consistent with array operations);
// Remove Property is a plain broadcast (extension.ts, modbench.vmad.removeProperty) with nothing
// to render here, and Set Type is a deliberately deferred scope reduction.

const dialogInputStyle: React.CSSProperties = {
  fontFamily: mono, fontSize: '12px',
  background: 'var(--vscode-input-background, #3c3c3c)', color: fg,
  border: '1px solid var(--vscode-input-border, #555)', padding: '2px 6px',
};

export function AddPropertyDialog({ onConfirm, onCancel }: Readonly<{
  onConfirm: (v: { name: string; type: string; value: unknown }) => void;
  onCancel: () => void;
}>) {
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('Int');
  const [value, setValue] = useState<unknown>(() => defaultOpValue('Int'));

  function changeType(t: string) { setType(t); setValue(defaultOpValue(t)); }

  const kind = opScalarKind(type);
  const inputStyle = dialogInputStyle;

  function valueControl(): React.ReactNode {
    if (kind === 'bool') {
      return <input type="checkbox" aria-label="New property value"
        checked={value === true} onChange={e => setValue(e.target.checked)} />;
    }
    if (kind != null) {
      return (
        <input
          type={kind === 'int' || kind === 'float' ? 'number' : 'text'}
          aria-label="New property value"
          style={inputStyle}
          onChange={e => {
            const s = e.target.value;
            if (kind === 'int') { const n = Number.parseInt(s, 10); setValue(Number.isNaN(n) ? 0 : n); return; }
            if (kind === 'float') { const n = Number.parseFloat(s); setValue(Number.isNaN(n) ? 0 : n); return; }
            setValue(s);
          }}
        />
      );
    }
    if (type === 'Object') {
      const fk = (value as { formKey?: string }).formKey ?? '';
      // The picker itself is a native QuickPick (only the extension host can call
      // vscode.window.createQuickPick) — there's no current reference to seed here (this is a
      // brand-new property), so pickFormKey gets an empty seed.
      return (
        <button
          aria-label="New property value"
          style={inputStyle}
          onClick={() => { void pickFormKey(fk, []).then(f => { if (f) setValue({ formKey: f, alias: -1 }); }); }}
        >
          {fk || <span style={{ opacity: 0.5 }}>— click to pick</span>}
        </button>
      );
    }
    return <span style={{ opacity: 0.5 }}>(empty)</span>;
  }

  return (
    <ModalShell title="Add property" confirmDisabled={name.trim() === ''}
      onCancel={onCancel} onConfirm={() => onConfirm({ name, type, value })}>
      <table><tbody>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Name</td>
        <td><input aria-label="New property name" style={inputStyle} value={name} onChange={e => setName(e.target.value)} /></td></tr>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Type</td>
        <td><select aria-label="New property type" style={inputStyle} value={type} onChange={e => changeType(e.target.value)}>
          {ADDABLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select></td></tr>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Value</td><td>{valueControl()}</td></tr>
      </tbody></table>
    </ModalShell>
  );
}
