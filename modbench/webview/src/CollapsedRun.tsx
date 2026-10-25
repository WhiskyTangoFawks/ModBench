import React from 'react';
import { DiskCell } from './DiskCell';
import { focusedRowStyle } from './gridStyles';
import type { FocusedCell } from './gridNavigation';
import type { RunRow } from './recordRows';

const INDENT_PER_LEVEL = 24;

/** editor.md, Rows, story 6: the row that holds a run, in the diff editor's unchanged-region colours. */
export function CollapsedRun({ row, columnCount, focusedCell, onFocusCell, onRestore }: Readonly<{
  row: RunRow;
  columnCount: number;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: null) => void;
  onRestore: () => void;
}>) {
  const focused = focusedCell?.rowKey === row.key;
  return (
    <tr style={focused ? focusedRowStyle : undefined}>
      <DiskCell
        colSpan={1 + columnCount}
        style={{
          paddingLeft: row.depth * INDENT_PER_LEVEL || undefined, cursor: 'pointer',
          background: 'var(--vscode-diffEditor-unchangedRegionBackground)',
          color: 'var(--vscode-diffEditor-unchangedRegionForeground)',
          boxShadow: '0 0 6px var(--vscode-diffEditor-unchangedRegionShadow)',
        }}
        isFocused={focused}
        onFocusCell={() => onFocusCell(row.key, null)}
        onActivate={onRestore}
        context={row.label.context}
      >
        {row.name}
      </DiskCell>
    </tr>
  );
}
