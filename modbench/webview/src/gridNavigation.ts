import type { ColumnKey } from './types';

// The one focused cell panel-wide (editor.md, The focused cell). `plugin` is the column's compound
// identity (ADR-0012), so two columns sharing a filename never both read as focused. `null` is the
// label column.
export interface FocusedCell {
  rowKey: string;
  plugin: ColumnKey | null;
}

export interface NavRow {
  key: string;
  parent: string | null;
  expandable: boolean;
  expanded: boolean;
}

type Navigation = { focus: FocusedCell } | { toggle: string } | null;

function visibleRowKey(rows: readonly NavRow[], rowKey: string): string | undefined {
  return rows
    .filter(r => rowKey === r.key || rowKey.startsWith(`${r.key}.`))
    .reduce<string | undefined>((nearest, r) => (nearest === undefined || r.key.length > nearest.length ? r.key : nearest), undefined);
}

export function navigate(
  key: string, rows: readonly NavRow[], columns: readonly ColumnKey[], focused: FocusedCell, page: number,
): Navigation {
  const at = rows.findIndex(r => r.key === visibleRowKey(rows, focused.rowKey));
  const row = rows[at];
  if (!row) return null;
  const toRow = (index: number): Navigation => {
    const target = rows[Math.min(rows.length - 1, Math.max(0, index))];
    return target ? { focus: { rowKey: target.key, plugin: focused.plugin } } : null;
  };
  const labelAndColumns = [null, ...columns];
  const toColumn = (step: number): Navigation => {
    const plugin = labelAndColumns[labelAndColumns.indexOf(focused.plugin) + step];
    return plugin === undefined ? null : { focus: { rowKey: row.key, plugin } };
  };

  switch (key) {
    case 'ArrowDown': return toRow(at + 1);
    case 'ArrowUp': return toRow(at - 1);
    case 'PageDown': return toRow(at + page);
    case 'PageUp': return toRow(at - page);
    case 'Home': return toRow(0);
    case 'End': return toRow(rows.length - 1);
    case 'ArrowRight': {
      if (focused.plugin !== null) return toColumn(1);
      if (!row.expandable) return null;
      if (!row.expanded) return { toggle: row.key };
      const child = rows[at + 1];
      return child?.parent === row.key ? { focus: { rowKey: child.key, plugin: null } } : null;
    }
    case 'ArrowLeft': {
      if (focused.plugin !== null) return toColumn(-1);
      if (row.expandable && row.expanded) return { toggle: row.key };
      return row.parent === null ? null : { focus: { rowKey: row.parent, plugin: null } };
    }
    default: return null;
  }
}
