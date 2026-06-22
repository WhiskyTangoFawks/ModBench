import React from 'react';
import { mono } from './gridStyles';

// Read-mode FormKey link button: renders a FormKey string as a clickable link
// that opens the referenced record. Shared by FormKeyCell (generic fields) and
// VmadSection (VMAD object properties).
export function FormKeyLink({ value, onOpen }: { value: string; onOpen: (fk: string) => void }) {
  return (
    <button
      onClick={() => onOpen(value)}
      style={{
        background: 'none',
        border: 'none',
        color: 'var(--vscode-textLink-foreground, #3794ff)',
        cursor: 'pointer',
        fontFamily: mono,
        fontSize: '12px',
        padding: 0,
        textDecoration: 'underline',
        textAlign: 'left',
      }}
    >
      {value}
    </button>
  );
}
