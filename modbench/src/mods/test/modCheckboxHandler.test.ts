import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn((_id: string, ..._args: unknown[]) => Promise.resolve()) }));

import { TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  commands: { executeCommand },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor,
  Uri: { from: uriFrom },
}));

import { onModCheckboxChanged } from '../modCheckboxHandler';
import { ModNode, OverwriteNode } from '../ModListProvider';

beforeEach(() => { executeCommand.mockClear(); });

function modNode(name: string, enabled = true): ModNode {
  return new ModNode({ kind: 'mod', name, enabled });
}

describe('onModCheckboxChanged', () => {
  it('fires enable once over every mod the click checked', async () => {
    const a = modNode('A', false);
    const b = modNode('B', false);

    await onModCheckboxChanged({ items: [[a, 1], [b, 1]] });

    expect(executeCommand.mock.calls).toEqual([['modbench.mod.enable', a, [a, b]]]);
  });

  it('fires disable for the mods it unchecked and enable for the ones it checked, each once', async () => {
    const on = modNode('On', false);
    const off = modNode('Off');

    await onModCheckboxChanged({ items: [[off, 0], [on, 1]] });

    expect(executeCommand.mock.calls).toEqual([
      ['modbench.mod.enable', on, [on]],
      ['modbench.mod.disable', off, [off]],
    ]);
  });

  it('ignores a non-mod row (the pinned Overwrite row sharing the tree)', async () => {
    await onModCheckboxChanged({ items: [[new OverwriteNode([], 'MO2'), 1]] });

    expect(executeCommand).not.toHaveBeenCalled();
  });
});
