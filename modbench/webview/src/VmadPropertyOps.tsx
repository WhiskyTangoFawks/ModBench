import React, { useState } from 'react';
import { fg, mono } from './gridStyles';
import { FormKeyPicker } from './FormKeyPicker';
import { ModalShell } from './ModalShell';
import type { RecordSessionClient } from './RecordSessionClient';
import { ADDABLE_TYPES, PROP_FLAGS, defaultOpValue, opScalarKind, type OnStructOp } from './vmadOps';

// ── structural ops (13.8): add / remove property ───────────────────────────────

const iconBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', padding: 0, lineHeight: 1,
};

const structBtnStyle: React.CSSProperties = {
  ...iconBtnStyle, fontSize: '14px', padding: '0 4px', color: fg,
};

const dialogInputStyle: React.CSSProperties = {
  fontFamily: mono, fontSize: '12px',
  background: 'var(--vscode-input-background, #3c3c3c)', color: fg,
  border: '1px solid var(--vscode-input-border, #555)', padding: '2px 6px',
};

const flagSelectStyle: React.CSSProperties = { ...dialogInputStyle, fontSize: '11px' };

export function AddPropertyDialog({ client, onConfirm, onCancel }: Readonly<{
  client?: RecordSessionClient;
  onConfirm: (v: { name: string; type: string; value: unknown }) => void;
  onCancel: () => void;
}>) {
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('Int');
  const [value, setValue] = useState<unknown>(() => defaultOpValue('Int'));
  const [picking, setPicking] = useState(false);

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
    if (type === 'Object' && client != null) {
      const fk = (value as { formKey?: string }).formKey ?? '';
      if (picking) {
        return (
          <FormKeyPicker client={client} validTypes={[]}
            onSelect={f => { setValue({ formKey: f, alias: -1 }); setPicking(false); }}
            onClose={() => setPicking(false)} />
        );
      }
      return <button aria-label="New property value" style={inputStyle} onClick={() => setPicking(true)}>
        {fk || <span style={{ opacity: 0.5 }}>— click to pick</span>}
      </button>;
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

export function AddPropertyButton({ plugin, scriptName, onStructOp, client }: Readonly<{
  plugin: string; scriptName: string; onStructOp: OnStructOp; client?: RecordSessionClient;
}>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button title="Add property" onClick={() => setOpen(true)} style={structBtnStyle}>+ prop</button>
      {open && (
        <AddPropertyDialog
          client={client}
          onCancel={() => setOpen(false)}
          onConfirm={({ name, type, value }) => {
            setOpen(false);
            onStructOp(plugin, `VMAD\\${scriptName}\\${name}`,
              { op: 'add_property', type, name, flags: 'Edited', value });
          }}
        />
      )}
    </>
  );
}

export function RemovePropertyButton({ plugin, scriptName, propName, onStructOp }: Readonly<{
  plugin: string; scriptName: string; propName: string; onStructOp: OnStructOp;
}>) {
  return (
    <button
      title="Remove property"
      onClick={() => onStructOp(plugin, `VMAD\\${scriptName}\\${propName}`, { op: 'remove_property' })}
      style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)' }}
    >×</button>
  );
}

// Type dropdown (13.8.3) — changing it stages set_type, which resets the value on the backend.
export function SetTypeControl({ plugin, scriptName, propName, currentType, onStructOp }: Readonly<{
  plugin: string; scriptName: string; propName: string; currentType: string; onStructOp: OnStructOp;
}>) {
  const known = (ADDABLE_TYPES as readonly string[]).includes(currentType);
  return (
    <select
      aria-label={`Type for ${propName}`}
      title="Changing type resets the value"
      value={known ? currentType : ''}
      onChange={e => onStructOp(plugin, `VMAD\\${scriptName}\\${propName}`, { op: 'set_type', type: e.target.value })}
      style={{ ...dialogInputStyle, fontSize: '11px' }}
    >
      {!known && <option value="">{currentType || '—'}</option>}
      {ADDABLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
    </select>
  );
}

// Property flags control (13.8.4). The read model carries no per-property flag, so this is set-only
// (defaults to Edited) — staging set_flags applies the chosen value on save.
export function PropertyFlagsControl({ plugin, scriptName, propName, onStructOp }: Readonly<{
  plugin: string; scriptName: string; propName: string; onStructOp: OnStructOp;
}>) {
  return (
    <select aria-label={`Flags for ${propName}`} defaultValue="Edited" style={flagSelectStyle}
      onChange={e => onStructOp(plugin, `VMAD\\${scriptName}\\${propName}`, { op: 'set_flags', flags: e.target.value })}>
      {PROP_FLAGS.map(f => <option key={f} value={f}>{f}</option>)}
    </select>
  );
}
