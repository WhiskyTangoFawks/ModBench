import React from 'react';
import { mono } from './gridStyles';

// Shared modal chrome: a fixed dimmed overlay with a titled panel and a Cancel / confirm footer.
//
// AddPropertyDialog (VmadPropertyOps.tsx) is this shell's one remaining, deliberate user — a
// deliberate exception to the native-prompts-first rule: it collects three fields at once (name,
// type, value — the value control itself varying by type, including a FormKey picker for
// Object-typed properties), and a multi-step QuickPick chain to gather them one at a time would
// be worse UX than the single dialog. Do not mechanically convert AddPropertyDialog to native
// prompts — that needs a fresh design discussion.
export function ModalShell({ title, confirmLabel = 'Add', confirmDisabled, onConfirm, onCancel, children }: Readonly<{
  title: string;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}>) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--vscode-editor-background, #1e1e1e)', border: '1px solid var(--vscode-editorGroup-border, #444)', padding: 12, minWidth: 280 }}>
        <div style={{ fontFamily: mono, fontSize: '12px', marginBottom: 8 }}>{title}</div>
        {children}
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button onClick={onCancel} style={{ fontSize: '11px', padding: '2px 8px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={onConfirm} disabled={confirmDisabled}
            style={{ fontSize: '11px', padding: '2px 8px', cursor: 'pointer', background: 'var(--vscode-button-background, #0e639c)', color: 'var(--vscode-button-foreground, #fff)', border: 'none' }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
