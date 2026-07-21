import React, { useState } from 'react';
import { fg, mono } from './gridStyles';
import { ModalShell } from './ModalShell';
import { SCRIPT_FLAGS, type OnStructOp } from './vmadOps';

// ── structural ops (13.8.2): add / remove script ───────────────────────────────

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

export function AddScriptDialog({ onConfirm, onCancel }: Readonly<{
  onConfirm: (v: { name: string; flags: string }) => void; onCancel: () => void;
}>) {
  const [name, setName] = useState('');
  const [flags, setFlags] = useState<string>('Local');
  return (
    <ModalShell title="Add script" confirmDisabled={name.trim() === ''}
      onCancel={onCancel} onConfirm={() => onConfirm({ name, flags })}>
      <table><tbody>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Name</td>
        <td><input aria-label="New script name" style={dialogInputStyle} value={name} onChange={e => setName(e.target.value)} /></td></tr>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Flags</td>
        <td><select aria-label="New script flags" style={dialogInputStyle} value={flags} onChange={e => setFlags(e.target.value)}>
          {SCRIPT_FLAGS.map(f => <option key={f} value={f}>{f}</option>)}
        </select></td></tr>
      </tbody></table>
    </ModalShell>
  );
}

export function AddScriptButton({ plugin, onStructOp }: Readonly<{ plugin: string; onStructOp: OnStructOp }>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button title="Add script" onClick={() => setOpen(true)} style={structBtnStyle}>+ script</button>
      {open && (
        <AddScriptDialog
          onCancel={() => setOpen(false)}
          onConfirm={({ name, flags }) => {
            setOpen(false);
            onStructOp(plugin, `VMAD\\${name}`, { op: 'add_script', name, flags, properties: [] });
          }}
        />
      )}
    </>
  );
}

export function RemoveScriptButton({ plugin, scriptName, onStructOp }: Readonly<{
  plugin: string; scriptName: string; onStructOp: OnStructOp;
}>) {
  return (
    <button
      title="Remove script"
      onClick={() => onStructOp(plugin, `VMAD\\${scriptName}`, { op: 'remove_script' })}
      style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)' }}
    >×</button>
  );
}

// Script flags control (13.8.4) — reflects the current per-plugin flag, stages set_flags on change.
export function ScriptFlagsControl({ plugin, scriptName, current, onStructOp }: Readonly<{
  plugin: string; scriptName: string; current: string | null; onStructOp: OnStructOp;
}>) {
  const val = current && (SCRIPT_FLAGS as readonly string[]).includes(current) ? current : 'Local';
  return (
    <select aria-label={`Flags for ${scriptName}`} value={val} style={flagSelectStyle}
      onChange={e => onStructOp(plugin, `VMAD\\${scriptName}`, { op: 'set_flags', flags: e.target.value })}>
      {SCRIPT_FLAGS.map(f => <option key={f} value={f}>{f}</option>)}
    </select>
  );
}
