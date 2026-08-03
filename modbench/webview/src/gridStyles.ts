import type React from 'react';
import type { ConflictThis } from './types';

// Shared compare-grid presentation primitives, used by both the generic field
// rows (RecordPanel/DiffRow) and the VMAD section (VmadSection). Also used by
// DownloadsApp (Mod Management context) for its themed table cells — baseCell/
// headerCell are the only primitives that cross that boundary.

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

// Issue #222 / ADR-0034: the focus model's two paints. `focusedRowStyle` marks the row a focused
// cell lives in (xEdit's `toFullRowSelect`) and `focusedCellStyle` marks the one cell within it
// that carries focus (xEdit's `toExtendedFocus`), thicker so it reads as distinct from the row
// ring around it. Both are inset box-shadows, not `outline` — `outline` would also work in a real
// browser, but happy-dom (this project's webview test environment) silently drops an
// `outline-color: var(...)` declaration while accepting the identical `var()` inside `box-shadow`,
// and a style that can't be asserted in tests isn't one this codebase can keep honest. Both key
// off `--vscode-focusBorder` to match native VS Code focus theming, and both are state-driven off
// `isFocused`/`isRowFocused` rather than the browser's native `:focus` ring alone, so the paint and
// the real DOM focus this ticket establishes (issue #222 comment thread) can never disagree.
export const focusedRowStyle: React.CSSProperties = {
  boxShadow: 'inset 0 0 0 1px var(--vscode-focusBorder, #007fd4)',
};

export const focusedCellStyle: React.CSSProperties = {
  boxShadow: 'inset 0 0 0 2px var(--vscode-focusBorder, #007fd4)',
};
