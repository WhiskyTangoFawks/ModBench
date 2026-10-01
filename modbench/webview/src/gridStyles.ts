import type React from 'react';
import type { ConflictAll, ConflictThis } from './types';

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

/** A row's label cell, given the label column's look. */
export const labelCell = (column: React.CSSProperties): React.CSSProperties =>
  ({ ...baseCell, ...column, opacity: 0.75 });

// editor.md, A column's header: a Partial Form column is dimmed, header and cells alike, since
// the grid's <thead> is not sticky.
export const DIMMED_OPACITY = 0.55;

// editor.md, Columns, story 3: the narrow strip a collapsed column becomes, and the narrowest a
// drag leaves one.
export const COLLAPSED_COLUMN_WIDTH = 48;

/** A column's width, held by its header and every cell under it alike. The border box, as the
 *  drag that sets it measures the header. */
export const columnWidthStyle = (width: number | undefined): React.CSSProperties =>
  width == null ? {} : { width, minWidth: width, maxWidth: width, boxSizing: 'border-box' };

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

// editor-conflicts.md, The colours: each is a theme colour the extension manifest contributes.
export const CONFLICT_COLOURS = {
  rowOverride: 'modbench.conflict.rowOverride',
  rowConflict: 'modbench.conflict.rowConflict',
  identicalToMaster: 'modbench.conflict.identicalToMaster',
  override: 'modbench.conflict.override',
  conflictWins: 'modbench.conflict.conflictWins',
  conflictLoses: 'modbench.conflict.conflictLoses',
  conflictLosesText: 'modbench.conflict.conflictLosesText',
} as const;

const themeColour = (id: string): string => `var(--vscode-${id.replaceAll('.', '-')})`;

// NoConflict and OnlyOne are absent: they paint no background, so an expanded row deferring to its
// children reads the same way they do.
const ROW_BG: Partial<Record<ConflictAll, string>> = {
  Override: themeColour(CONFLICT_COLOURS.rowOverride),
  Conflict: themeColour(CONFLICT_COLOURS.rowConflict),
};

export const rowBackground = (conflictAll: ConflictAll): string | undefined => ROW_BG[conflictAll];

const CELL_BG: Partial<Record<ConflictThis, string>> = {
  IdenticalToMaster: themeColour(CONFLICT_COLOURS.identicalToMaster),
  Override: themeColour(CONFLICT_COLOURS.override),
  ConflictWins: themeColour(CONFLICT_COLOURS.conflictWins),
  ConflictLoses: themeColour(CONFLICT_COLOURS.conflictLoses),
};

export function getCellStyle(cellState: ConflictThis | undefined): React.CSSProperties {
  const backgroundColor = cellState && CELL_BG[cellState];
  if (!backgroundColor) return {};
  if (cellState === 'ConflictLoses') {
    return { backgroundColor, color: themeColour(CONFLICT_COLOURS.conflictLosesText) };
  }
  return { backgroundColor };
}

// xEdit's own words for each state.
const STATE_NAME: Record<ConflictThis, string> = {
  Master: 'Master',
  OnlyOne: 'Single Record',
  IdenticalToMaster: 'Identical to Master',
  Override: 'Override without conflict',
  ConflictWins: 'Conflict winner',
  ConflictLoses: 'Conflict loser',
};

export const conflictStateName = (cellState: ConflictThis): string => STATE_NAME[cellState];

// ADR-0018's focus paints use inset box-shadow, not `outline`: in a collapsed-border table a
// neighbour can overdraw an outline along the shared edge, and happy-dom drops
// `outline-color: var(...)`.
export const focusedRowStyle: React.CSSProperties = {
  boxShadow: 'inset 0 0 0 1px var(--vscode-focusBorder, #007fd4)',
};

export const focusedCellStyle: React.CSSProperties = {
  boxShadow: 'inset 0 0 0 2px var(--vscode-focusBorder, #007fd4)',
};
