import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ conflictTableHost: { postMessage: vi.fn() } }));

import { ConflictTableView } from './ConflictTable';
import { conflictTableHost } from './vscode';
import { required } from './test/fixtures';
import {
  CONFLICT_TABLE_READY, CONFLICT_TABLE_SHOWN, type ConflictCell, type ConflictColumn, type ConflictRow, type ConflictRowState, type ConflictTable,
} from '../../src/wire/conflictTable';

function show(table: ConflictTable, notice?: string): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: CONFLICT_TABLE_SHOWN, table, notice } })); });
}

const modColumn = (name: string, opened = false, state: ConflictColumn['state'] = null): ConflictColumn => ({ name, origin: { kind: 'mod', name }, opened, state });
const overwriteColumn: ConflictColumn = { name: 'Overwrite', origin: { kind: 'runtimeOutput' }, opened: false, state: null };
const columns: ConflictColumn[] = [modColumn('Low'), modColumn('Opened', true), overwriteColumn];
const copyFile = (path: string): ConflictRow =>
  ({ kind: 'file', name: path.split('/').at(-1) ?? path, path, cells: [{ state: null }, { state: null }, null], state: null });
const folder = (path: string, rows: ConflictRow[]): ConflictRow =>
  ({ kind: 'folder', name: path.split('/').at(-1) ?? path, path, rows, state: null });

const tree: ConflictRow[] = [
  folder('textures', [folder('textures/armor', [copyFile('textures/armor/a.dds')]), copyFile('textures/b.dds')]),
  copyFile('c.ini'),
];

const rowNames = (): string[] => Array.from(document.querySelectorAll('tbody tr')).map((row) => row.querySelector('td')?.textContent ?? '');
const rowOf = (name: string): HTMLElement => required(screen.getByText(name).closest('tr'), `${name}'s row`);
const focusedRow = (): string | undefined => document.querySelector('tbody tr[aria-selected="true"] td')?.textContent ?? undefined;
const press = (key: string) => fireEvent.keyDown(required(document.querySelector('tbody'), 'the table body'), { key });

beforeEach(() => {
  vi.mocked(conflictTableHost.postMessage).mockClear();
  render(<ConflictTableView />);
});

describe('the conflict table before and in place of a table', () => {
  it('tells the host it is ready, and shows an empty table until the table lands', () => {
    expect(vi.mocked(conflictTableHost.postMessage).mock.calls).toEqual([[{ type: CONFLICT_TABLE_READY }]]);
    expect(document.querySelector('table')).toBeInTheDocument();
    expect(rowNames()).toEqual([]);
  });

  it('shows a message in place of the table', () => {
    show({ kind: 'table', columns, rows: tree });
    show({ kind: 'message', text: 'No file order conflicts.' });

    expect(screen.getByText('No file order conflicts.')).toBeInTheDocument();
    expect(document.querySelector('table')).not.toBeInTheDocument();
  });

  it('shows a failed read as the error row: the error icon, "Failed to load:" and the reason, the reason again in its tooltip', () => {
    show({ kind: 'error', reason: 'disk gone' });

    const row = screen.getByText('Failed to load: disk gone');
    expect(row).toHaveAttribute('title', 'disk gone');
    expect(row.querySelector('.codicon.codicon-error')).not.toBeNull();
    expect(document.querySelector('table')).not.toBeInTheDocument();
  });

  it('shows the message line above the rows it keeps, until a table with none replaces it', () => {
    show({ kind: 'table', columns, rows: tree }, 'Showing the last good read: disk gone');

    expect(screen.getByText('Showing the last good read: disk gone')).toBeInTheDocument();
    expect(rowNames()).toEqual(['▼textures', '▼armor', 'a.dds', 'b.dds', 'c.ini']);

    show({ kind: 'table', columns, rows: tree });

    expect(screen.queryByText('Showing the last good read: disk gone')).not.toBeInTheDocument();
  });
});

describe('the conflict table\'s columns', () => {
  beforeEach(() => show({ kind: 'table', columns, rows: tree }));

  it('heads each column with its mod\'s name, after the rows\' own column', () => {
    expect(Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent)).toEqual(['', 'Low', 'Opened', 'Overwrite']);
  });

  it('outlines the opened mod\'s column, its header and its cells', () => {
    const outlined = (cell: Element | undefined) => (cell instanceof HTMLElement ? cell.style.boxShadow !== '' : false);
    const headers = Array.from(document.querySelectorAll('thead th'));
    const cells = Array.from(rowOf('c.ini').querySelectorAll('td'));
    expect(headers.map(outlined)).toEqual([false, false, true, false]);
    expect(cells.map(outlined)).toEqual([false, false, true, false]);
  });

  it('hands a mod column header\'s menu its mod, and Overwrite\'s none', () => {
    const contexts = Array.from(document.querySelectorAll('thead th')).map((header) => header.getAttribute('data-vscode-context'));
    expect(contexts.map((context) => context && JSON.parse(context) as unknown)).toEqual([
      null,
      { webviewSection: 'conflictColumn', mod: 'Low', preventDefaultContextMenuItems: true },
      { webviewSection: 'conflictColumn', mod: 'Opened', preventDefaultContextMenuItems: true },
      null,
    ]);
  });
});

describe('a mod named as Overwrite is', () => {
  it('a column of its own beside Overwrite\'s, its header\'s menu handed the mod, as the columns change', () => {
    show({ kind: 'table', columns: [modColumn('Overwrite'), overwriteColumn], rows: [] });
    show({ kind: 'table', columns: [modColumn('Low'), overwriteColumn, modColumn('Overwrite')], rows: [] });

    const headers = Array.from(document.querySelectorAll('thead th')).slice(1);
    expect(headers.map((header) => [header.textContent, header.getAttribute('data-vscode-context')])).toEqual([
      ['Low', JSON.stringify({ webviewSection: 'conflictColumn', mod: 'Low', preventDefaultContextMenuItems: true })],
      ['Overwrite', null],
      ['Overwrite', JSON.stringify({ webviewSection: 'conflictColumn', mod: 'Overwrite', preventDefaultContextMenuItems: true })],
    ]);
  });
});

describe('the conflict table\'s cells', () => {
  const contextsOf = (cells: (ConflictCell | null)[]) => {
    show({ kind: 'table', columns, rows: [{ kind: 'file', name: 'a.dds', path: 'a.dds', cells, state: null }] });
    return Array.from(rowOf('a.dds').querySelectorAll('td')).slice(1)
      .map((td) => td.getAttribute('data-vscode-context')).map((context) => context && JSON.parse(context) as unknown);
  };
  const cell = (winning?: true): ConflictCell => ({ state: null, ...(winning && { winning }) });

  it('hand a menu their origin and file where the copy is not the winning one', () => {
    expect(contextsOf([cell(), cell(true), null])).toEqual([
      { webviewSection: 'conflictCell', origin: { kind: 'mod', name: 'Low' }, path: 'a.dds', preventDefaultContextMenuItems: true }, null, null,
    ]);
  });

  it('hand a menu nothing from Overwrite\'s winning copy, nor from a column with no copy', () => {
    expect(contextsOf([null, cell(), cell(true)])).toEqual([
      null, { webviewSection: 'conflictCell', origin: { kind: 'mod', name: 'Opened' }, path: 'a.dds', preventDefaultContextMenuItems: true }, null,
    ]);
  });
});

describe('the conflict table\'s rows', () => {
  beforeEach(() => show({ kind: 'table', columns, rows: tree }));

  it('opens with every folder expanded, each row under its folder', () => {
    expect(rowNames()).toEqual(['▼textures', '▼armor', 'a.dds', 'b.dds', 'c.ini']);
  });

  it('collapses and expands a folder by a click on it', () => {
    fireEvent.click(rowOf('textures'));
    expect(rowNames()).toEqual(['▶textures', 'c.ini']);

    fireEvent.click(rowOf('textures'));
    expect(rowNames()).toEqual(['▼textures', '▼armor', 'a.dds', 'b.dds', 'c.ini']);
  });

  it('keeps the folders I collapsed as the table follows the disk, and opens a new folder expanded', () => {
    fireEvent.click(rowOf('armor'));

    show({ kind: 'table', columns, rows: [...tree, folder('meshes', [copyFile('meshes/m.nif')])] });

    expect(rowNames()).toEqual(['▼textures', '▶armor', 'b.dds', 'c.ini', '▼meshes', 'm.nif']);
  });

  it('keeps the scroll as the table follows the disk', () => {
    const scroller = required(document.querySelector('table')?.parentElement, 'the table\'s scroller');
    scroller.scrollTop = 40;

    show({ kind: 'table', columns, rows: [...tree, copyFile('d.ini')] });

    expect(scroller.scrollTop).toBe(40);
    expect(document.querySelector('table')?.parentElement).toBe(scroller);
  });
});

describe('the conflict table\'s keys, a VS Code tree\'s', () => {
  beforeEach(() => show({ kind: 'table', columns, rows: tree }));

  it('Down, Up, End and Home move through the rows shown', () => {
    fireEvent.click(rowOf('b.dds'));
    press('ArrowDown');
    expect(focusedRow()).toBe('c.ini');
    press('ArrowUp');
    press('ArrowUp');
    expect(focusedRow()).toBe('a.dds');
    press('Home');
    expect(focusedRow()).toBe('▼textures');
    press('End');
    expect(focusedRow()).toBe('c.ini');
  });

  it('Page Down and Page Up move a page, and stop at the ends', () => {
    fireEvent.click(rowOf('b.dds'));
    press('PageDown');
    press('PageDown');
    expect(focusedRow()).toBe('c.ini');
    press('PageUp');
    expect(focusedRow()).toBe('b.dds');
  });

  it('Left collapses a folder and then goes to its parent, and Right expands it and then goes to its first row', () => {
    fireEvent.click(rowOf('a.dds'));
    press('ArrowLeft');
    expect(focusedRow()).toBe('▼armor');
    press('ArrowLeft');
    expect(focusedRow()).toBe('▶armor');
    expect(rowNames()).toEqual(['▼textures', '▶armor', 'b.dds', 'c.ini']);
    press('ArrowRight');
    expect(rowNames()).toEqual(['▼textures', '▼armor', 'a.dds', 'b.dds', 'c.ini']);
    press('ArrowRight');
    expect(focusedRow()).toBe('a.dds');
  });
});

describe('the conflict table\'s colours, the record panel\'s', () => {
  const cell = (state: ConflictCell['state'], unreadable?: string): ConflictCell => ({ state, ...(unreadable === undefined ? {} : { unreadable }) });
  const styled = (element: Element | null | undefined): CSSStyleDeclaration => {
    if (!(element instanceof HTMLElement)) throw new Error('not an element');
    return element.style;
  };
  const cellsOf = (name: string): HTMLElement[] => Array.from(rowOf(name).querySelectorAll('td')).slice(1);

  const coloured: ConflictRow[] = [
    folder('f', [
      { kind: 'file', name: 'a.dds', path: 'f/a.dds', state: 'Conflict', cells: [cell('Master'), cell('ConflictLoses'), cell('ConflictWins')] },
      { kind: 'file', name: 'b.dds', path: 'f/b.dds', state: 'Override', cells: [cell('Master'), cell('IdenticalToMaster'), cell('Override')] },
    ]),
    { kind: 'file', name: 'c.ini', path: 'c.ini', state: null, cells: [cell(null, 'in use'), cell(null), null] },
  ];
  const folderOf = (state: ConflictRowState | null): ConflictRow[] => [{ kind: 'folder', name: 'f', path: 'f', rows: [copyFile('f/a.dds')], state }];

  beforeEach(() => show({
    kind: 'table',
    columns: [modColumn('Low', false, 'Master'), modColumn('Opened', true, 'ConflictLoses'), { ...overwriteColumn, state: 'ConflictWins' }],
    rows: coloured.map((row) => (row.kind === 'folder' ? { ...row, state: 'Conflict' } : row)),
  }));

  it('paints each cell as the record panel paints a field in that state, and a Master cell nothing', () => {
    expect(cellsOf('a.dds').map((td) => td.style.backgroundColor)).toEqual([
      '', 'var(--vscode-modbench-conflictLoses)', 'var(--vscode-modbench-conflictWins)',
    ]);
    expect(cellsOf('b.dds').map((td) => td.style.backgroundColor)).toEqual([
      '', 'var(--vscode-modbench-conflictIdenticalToMaster)', 'var(--vscode-modbench-conflictOverride)',
    ]);
  });

  it('paints each column\'s header with its column\'s worst state', () => {
    const headers = Array.from(document.querySelectorAll('thead th')).slice(1);
    expect(headers.map((th) => styled(th).backgroundColor)).toEqual([
      '', 'var(--vscode-modbench-conflictLoses)', 'var(--vscode-modbench-conflictWins)',
    ]);
  });

  it('paints each file row by its state, and a row of unknown state not at all', () => {
    expect(styled(rowOf('a.dds')).backgroundColor).toBe('var(--vscode-modbench-conflictRowConflict)');
    expect(styled(rowOf('b.dds')).backgroundColor).toBe('var(--vscode-modbench-conflictRowOverride)');
    expect(styled(rowOf('c.ini')).backgroundColor).toBe('');
  });

  it('paints a collapsed folder with the worst state beneath it, and an expanded one not at all', () => {
    expect(styled(rowOf('f')).backgroundColor).toBe('');

    fireEvent.click(rowOf('f'));

    expect(styled(rowOf('f')).backgroundColor).toBe('var(--vscode-modbench-conflictRowConflict)');
  });

  it('paints a collapsed folder of no known state not at all', () => {
    show({ kind: 'table', columns, rows: folderOf(null) });

    fireEvent.click(rowOf('f'));

    expect(styled(rowOf('f')).backgroundColor).toBe('');
  });

  it('says why in the tooltip of a copy that could not be read, and gives it no colour', () => {
    const [unreadable, unknown] = cellsOf('c.ini');
    expect(unreadable?.title).toBe('in use');
    expect(unreadable?.style.backgroundColor).toBe('');
    expect(unknown?.title).toBe('');
  });
});

describe('the conflict table\'s cell values', () => {
  const MODIFIED = Date.UTC(2023, 10, 14, 12);
  const valued: ConflictRow = {
    kind: 'file', name: 'v.dds', path: 'v.dds', state: 'Conflict',
    cells: [
      { state: 'Master', value: '512 B', size: 512, modified: MODIFIED },
      { state: 'ConflictWins', value: '1.5 MB', size: 1_572_864, modified: MODIFIED, winning: true },
      null,
    ],
  };
  const cellsOf = (): HTMLElement[] => Array.from(rowOf('v.dds').querySelectorAll('td')).slice(1);

  beforeEach(() => show({ kind: 'table', columns, rows: [valued] }));

  it('shows the cell\'s value, and nothing in a column with no copy', () => {
    expect(cellsOf().map((cell) => cell.textContent)).toEqual(['512 B', '1.5 MB', '']);
  });

  it('names the mod, the state in xEdit\'s words, the size and the date modified in the tooltip', () => {
    expect(cellsOf()[1]?.title).toBe(['Opened', 'Conflict winner', '1,572,864 bytes', new Date(MODIFIED).toLocaleString()].join('\n'));
  });

  it('names the state as not known on a readable copy in a row where another could not be read', () => {
    const unknown: ConflictRow = {
      kind: 'file', name: 'u.dds', path: 'u.dds', state: null,
      cells: [{ state: null, unreadable: 'in use' }, { state: null, value: '2 KB', size: 2048, modified: MODIFIED }, null],
    };
    show({ kind: 'table', columns, rows: [unknown] });

    const [reason, readable] = Array.from(rowOf('u.dds').querySelectorAll('td')).slice(1);
    expect([reason?.title, readable?.title]).toEqual(['in use', ['Opened', 'State not known', '2,048 bytes', new Date(MODIFIED).toLocaleString()].join('\n')]);
  });
});
