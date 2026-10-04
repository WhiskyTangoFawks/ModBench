import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ conflictTableHost: { postMessage: vi.fn() } }));

import { ConflictTableView } from './ConflictTable';
import { conflictTableHost } from './vscode';
import { required } from './test/fixtures';
import {
  CONFLICT_TABLE_READY, CONFLICT_TABLE_SHOWN, type ConflictColumn, type ConflictRow, type ConflictTable,
} from '../../src/wire/conflictTable';

function show(table: ConflictTable): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: CONFLICT_TABLE_SHOWN, table } })); });
}

const columns: ConflictColumn[] = [
  { name: 'Low', isMod: true, opened: false },
  { name: 'Opened', isMod: true, opened: true },
  { name: 'Overwrite', isMod: false, opened: false },
];
const copyFile = (path: string): ConflictRow =>
  ({ kind: 'file', name: path.split('/').at(-1) ?? path, path, cells: [{}, {}, null] });
const folder = (path: string, rows: ConflictRow[]): ConflictRow =>
  ({ kind: 'folder', name: path.split('/').at(-1) ?? path, path, rows });

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
