import type React from 'react';
import type { ConflictThis } from './types';

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
  userSelect: 'none',
};

export const headerCell: React.CSSProperties = { ...baseCell, fontWeight: 600 };

// editor.md, A column's header: a Partial Form column is dimmed, header and cells alike, since
// the grid's <thead> is not sticky.
export const DIMMED_OPACITY = 0.55;

// editor.md, Columns, story 3: the narrow strip a collapsed column becomes, and the narrowest a
// drag leaves one.
export const COLLAPSED_COLUMN_WIDTH = 48;

/** A column's width, held by its header and every cell under it alike. */
export const columnWidthStyle = (width: number | undefined): React.CSSProperties =>
  width == null ? {} : { width, minWidth: width, maxWidth: width };

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

// ADR-0018's focus paints use inset box-shadow, not `outline`: in a collapsed-border table a
// neighbour can overdraw an outline along the shared edge, and happy-dom drops
// `outline-color: var(...)`.
export const focusedRowStyle: React.CSSProperties = {
  boxShadow: 'inset 0 0 0 1px var(--vscode-focusBorder, #007fd4)',
};

export const focusedCellStyle: React.CSSProperties = {
  boxShadow: 'inset 0 0 0 2px var(--vscode-focusBorder, #007fd4)',
};
