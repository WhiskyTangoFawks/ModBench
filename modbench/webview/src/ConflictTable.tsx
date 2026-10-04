// mods-conflicts.md: the conflict table the host builds, drawn as a folder tree under the mods'
// columns.

import React, { useEffect, useRef, useState } from 'react';
import { conflictTableHost } from './vscode';
import { navigate, type NavRow } from './gridNavigation';
import { ExpandArrow } from './ExpandArrow';
import { baseCell, conflictStateName, focusedRowStyle, getCellStyle, headerBackground, headerCell, rowBackground } from './gridStyles';
import {
  CONFLICT_TABLE_READY, parseConflictTableShown,
  type ConflictCell, type ConflictCellContext, type ConflictColumn, type ConflictColumnContext, type ConflictRow, type ConflictTable, type ConflictTableShown,
} from '../../src/wire/conflictTable';

const NOT_READ_YET: ConflictTable = { kind: 'table', columns: [], rows: [] };

const outline = 'var(--vscode-focusBorder, #007fd4)';
const openedColumnStyle: React.CSSProperties = { boxShadow: `inset 2px 0 0 ${outline}, inset -2px 0 0 ${outline}` };
const columnStyle = (column: ConflictColumn): React.CSSProperties => (column.opened ? openedColumnStyle : {});

function headerContext({ origin }: ConflictColumn): string | undefined {
  if (origin.kind !== 'mod') return undefined;
  const context: ConflictColumnContext = { webviewSection: 'conflictColumn', mod: origin.name, preventDefaultContextMenuItems: true };
  return JSON.stringify(context);
}

function cellContext({ origin }: ConflictColumn, path: string, cell: ConflictCell | null): string | undefined {
  if (cell === null || cell.winning === true) return undefined;
  const context: ConflictCellContext = { webviewSection: 'conflictCell', origin, path, preventDefaultContextMenuItems: true };
  return JSON.stringify(context);
}

function cellTooltip(column: ConflictColumn, cell: ConflictCell | null): string | undefined {
  if (cell === null) return undefined;
  if (cell.unreadable !== undefined) return cell.unreadable;
  if (cell.size === undefined || cell.modified === undefined) return undefined;
  return [column.name, cell.state === null ? 'State not known' : conflictStateName(cell.state), `${cell.size.toLocaleString()} bytes`, new Date(cell.modified).toLocaleString()].join('\n');
}

// A collapsed folder shows the worst state beneath it, and an expanded one none (mods-conflicts.md, Cells, story 1).
const rowStyle = (row: ConflictRow, expanded: boolean): React.CSSProperties => {
  const state = row.kind === 'folder' && expanded ? null : row.state;
  return { backgroundColor: state === null ? undefined : rowBackground(state) };
};

const columnKey = ({ origin }: ConflictColumn): string => (origin.kind === 'mod' ? `mod/${origin.name}` : origin.kind);

interface ShownRow { row: ConflictRow; depth: number; nav: NavRow }

function shownRows(rows: readonly ConflictRow[], collapsed: ReadonlySet<string>, parent: string | null, depth: number): ShownRow[] {
  return rows.flatMap((row) => {
    const expanded = row.kind === 'folder' && !collapsed.has(row.path);
    const shown: ShownRow = { row, depth, nav: { key: row.path, parent, expandable: row.kind === 'folder', expanded } };
    return row.kind === 'folder' && expanded ? [shown, ...shownRows(row.rows, collapsed, row.path, depth + 1)] : [shown];
  });
}

export function ConflictTableView() {
  const [{ table, notice }, setShown] = useState<Pick<ConflictTableShown, 'table' | 'notice'>>({ table: NOT_READ_YET });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const headerRow = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      const shown = parseConflictTableShown(event.data);
      if (shown) setShown(shown);
    };
    window.addEventListener('message', listener);
    conflictTableHost.postMessage({ type: CONFLICT_TABLE_READY });
    return () => window.removeEventListener('message', listener);
  }, []);

  // Keyed on the focus alone: a table that follows the disk leaves the scroll where it is.
  useEffect(() => {
    scroller.current?.querySelector('tr[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  if (table.kind === 'message') return <p>{table.text}</p>;
  if (table.kind === 'error') {
    return <p title={table.reason}><span className="codicon codicon-error" aria-hidden /> Failed to load: {table.reason}</p>;
  }

  const rows = shownRows(table.rows, collapsed, null, 0);
  const navRows = rows.map(({ nav }) => nav);
  const current = navRows.some(({ key }) => key === focused) ? focused : navRows[0]?.key;

  const toggle = (path: string) => setCollapsed((was) => {
    const next = new Set(was);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  function handleKey(e: React.KeyboardEvent<HTMLTableElement>) {
    if (current === undefined || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const rowHeight = e.currentTarget.querySelector<HTMLElement>('tbody tr')?.offsetHeight ?? 0;
    const viewport = (scroller.current?.clientHeight ?? 0) - (headerRow.current?.offsetHeight ?? 0);
    const page = rowHeight > 0 ? Math.max(1, Math.floor(viewport / rowHeight) - 1) : 1;
    const move = navigate(e.key, navRows, [], { rowKey: current, plugin: null }, page);
    if (!move) return;
    e.preventDefault();
    if ('toggle' in move) toggle(move.toggle);
    else setFocused(move.focus.rowKey);
  }

  return (
    <>
      {notice !== undefined && <p>{notice}</p>}
      <div ref={scroller} style={{ overflow: 'auto', height: '100vh' }}>
        <table role="treegrid" tabIndex={0} onKeyDown={handleKey} style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr ref={headerRow}>
              <th style={headerCell} />
              {table.columns.map((column) => (
                <th key={columnKey(column)} style={{ ...headerCell, ...columnStyle(column), backgroundColor: headerBackground(column.state) }} data-vscode-context={headerContext(column)}>
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, depth, nav }) => (
              <tr
                key={row.path}
                aria-selected={nav.key === current}
                aria-expanded={nav.expandable ? nav.expanded : undefined}
                style={{ ...rowStyle(row, nav.expanded), ...(nav.key === current ? focusedRowStyle : undefined) }}
                onClick={() => {
                  setFocused(row.path);
                  if (row.kind === 'folder') toggle(row.path);
                }}
              >
                <td style={{ ...baseCell, paddingLeft: 8 + depth * 16 }}>
                  {row.kind === 'folder' && <ExpandArrow expanded={nav.expanded} />}
                  {row.name}
                </td>
                {table.columns.map((column, index) => {
                  const cell: ConflictCell | null = row.kind === 'file' ? row.cells[index] ?? null : null;
                  return (
                    <td key={columnKey(column)} title={cellTooltip(column, cell)} data-vscode-context={cellContext(column, row.path, cell)} style={{ ...baseCell, ...getCellStyle(cell?.state ?? undefined), ...columnStyle(column) }}>
                      {cell?.value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
