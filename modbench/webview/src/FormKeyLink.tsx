import React from 'react';
import { mono } from './gridStyles';

// A FormKey rendered as its link affordance. Shared by FormKeyCell (generic fields) and
// VmadSection (VMAD object properties).
//
// Issue #111: the click gesture is split here so it stays uniform across every cell in the
// grid — Ctrl+click follows the reference (xEdit's vstViewClick likewise requires VK_CONTROL),
// which leaves plain click free to mean "edit this cell". Plain click is the caller's to
// define: FormKeyCell opens the picker with it; a read-only cell passes nothing, and plain
// click there does nothing.
export function FormKeyLink({ value, onOpen, onPlainClick }: Readonly<{
  value: string;
  onOpen: (fk: string) => void;
  onPlainClick?: () => void;
}>) {
  return (
    <button
      onClick={e => {
        if (e.ctrlKey || e.metaKey) onOpen(value);
        else onPlainClick?.();
      }}
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
