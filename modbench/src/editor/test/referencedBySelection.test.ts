import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon }));

import { ReferencedByHolderNode } from '../referencedByList';
import { ReferencedBySelection } from '../referencedBySelection';

const holder = () => new ReferencedByHolderNode('1', '000002:A.esm', 'Named', { name: 'A.esm', origin: 'A.esm' }, []);

describe('ReferencedBySelection', () => {
  it('is the row last opened, announced as the selection', () => {
    const selection = new ReferencedBySelection();
    const heard: unknown[][] = [];
    selection.onDidChangeSelection((e) => heard.push([...e.selection]));
    const row = holder();

    selection.opening(row.command?.arguments?.[0]);

    expect(selection.selection).toEqual([row]);
    expect(heard).toEqual([[row]]);
  });

  it('ignores an open that is no row of the list', () => {
    const selection = new ReferencedBySelection();

    selection.opening({ argument: { kind: 'record', formKey: '000002:A.esm' } });

    expect(selection.selection).toEqual([]);
  });

  it('is emptied when a new list replaces the old', () => {
    const selection = new ReferencedBySelection();
    selection.opening(holder().command?.arguments?.[0]);

    selection.clear();

    expect(selection.selection).toEqual([]);
  });
});
