import React from 'react';
import { mono } from './gridStyles';

// Shared modal chrome: a fixed dimmed overlay with a titled panel and a Cancel / confirm footer.
// Extracted from VmadSection's add-property / add-script dialogs (issue #139) so the record
// panel's revert-group confirmation reuses the same chrome rather than duplicating it. Callers
// own the body layout — the VMAD dialogs wrap their fields in a <table>, the confirmation lists
// members as plain rows — so the shell does not impose a table.
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
