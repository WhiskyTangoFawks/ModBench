import React from 'react';
import { fg, mono } from './gridStyles';
import { pickScriptName } from './addScriptBridge';
import { SCRIPT_FLAGS, type OnStructOp } from './vmadOps';

// ── structural ops (13.8.2): add / remove script ───────────────────────────────

const iconBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', padding: 0, lineHeight: 1,
};

const structBtnStyle: React.CSSProperties = {
  ...iconBtnStyle, fontSize: '14px', padding: '0 4px', color: fg,
};

// Issue #212: this used to be shared with the deleted AddScriptDialog's name/flags inputs (hence
// the old name, "dialogInputStyle") — now that the dialog is gone, ScriptFlagsControl's <select>
// is its only consumer, so it's inlined directly rather than kept as a misleadingly-named
// single-use base style.
const flagSelectStyle: React.CSSProperties = {
  fontFamily: mono, fontSize: '11px',
  background: 'var(--vscode-input-background, #3c3c3c)', color: fg,
  border: '1px solid var(--vscode-input-border, #555)', padding: '2px 6px',
};

// Issue #212: the add-script dialog's own ModalShell (name + flags fields) was deleted — "Add
// script" is now a native input box (pickScriptName) collecting the one field it actually needs,
// a name. New scripts always start with 'Local' flags (no field for it any more, per the issue's
// explicit "one field, a name") — ScriptFlagsControl below is the only way to change it, same as
// it already was for every script after its first add. An empty/whitespace name is rejected by
// the native input box's own validateInput (extension-host side, recordPanelMessageRouter.ts),
// never reaching here at all — pickScriptName resolves null only on Escape/blur.
export function AddScriptButton({ plugin, onStructOp }: Readonly<{ plugin: string; onStructOp: OnStructOp }>) {
  return (
    <button
      title="Add script"
      onClick={() => {
        void pickScriptName().then(name => {
          if (name == null) return;
          onStructOp(plugin, `VMAD\\${name}`, { op: 'add_script', name, flags: 'Local', properties: [] });
        });
      }}
      style={structBtnStyle}
    >+ script</button>
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
