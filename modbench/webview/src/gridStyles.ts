import type React from 'react';
import type { ConflictThis } from './types';

// Shared compare-grid presentation primitives, used by both the generic field
// rows (RecordPanel/DiffRow) and the VMAD section (VmadSection).

export const mono = 'var(--vscode-editor-font-family, "Consolas", monospace)';
export const fg = 'var(--vscode-editor-foreground, #ccc)';
export const borderColor = 'var(--vscode-editorGroup-border, #444)';

export const baseCell: React.CSSProperties = {
  border: `1px solid ${borderColor}`,
  padding: '3px 8px',
  verticalAlign: 'top',
  fontFamily: mono,
  fontSize: '12px',
  color: fg,
  maxWidth: '260px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const headerCell: React.CSSProperties = { ...baseCell, fontWeight: 600 };

export const toggleBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: fg,
  fontFamily: mono,
  fontSize: '11px',
  padding: '0 3px 0 0',
  lineHeight: 1,
};

const CONFLICT_RGB: Partial<Record<ConflictThis, string>> = {
  IdenticalToMaster: '150,150,150',
  Override:          '76,175,80',
  ConflictWins:      '255,152,0',
  ConflictLoses:     '244,67,54',
};

export const getConflictBg = (c: ConflictThis | undefined, alpha: number): string | undefined => {
  const rgb = c !== undefined ? CONFLICT_RGB[c] : undefined;
  return rgb ? `rgba(${rgb},${alpha})` : undefined;
};

export function getCellStyle(cellState: ConflictThis | undefined): React.CSSProperties {
  const bg = getConflictBg(cellState, 0.18);
  if (!bg) return {};
  if (cellState === 'ConflictLoses') return { backgroundColor: bg, color: 'rgba(244,67,54,1)' };
  return { backgroundColor: bg };
}
