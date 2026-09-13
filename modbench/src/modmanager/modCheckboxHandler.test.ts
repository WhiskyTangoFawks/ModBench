import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showErrorMessage, showWarningMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

import { TreeItem, TreeItemCollapsibleState, ThemeIcon } from '../test/vscodeMock';

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  TreeItem, TreeItemCollapsibleState, ThemeIcon,
}));

import { onModCheckboxChanged } from './modCheckboxHandler';
import { ModNode } from './ModListProvider';
import { ErrorNode } from '../errorNode';
import { FakeLogOutputChannel } from '../test/fakeOutputChannel';

beforeEach(() => { showErrorMessage.mockClear(); showWarningMessage.mockClear(); });

function modNode(name: string, enabled = true): ModNode {
  return new ModNode({ kind: 'mod', name, enabled });
}

describe('onModCheckboxChanged', () => {
  it('enables/disables the mod and does nothing else on success', async () => {
    const setModEnabled = vi.fn().mockResolvedValue(undefined);
    const invalidate = vi.fn();
    const modListProvider = { setModEnabled, invalidate };
    const channel = new FakeLogOutputChannel();

    await onModCheckboxChanged({ items: [[modNode('TestMod'), 1]] }, modListProvider, channel);

    expect(setModEnabled).toHaveBeenCalledWith('TestMod', true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('reports and invalidates so the checkbox resyncs when the toggle fails', async () => {
    const setModEnabled = vi.fn().mockRejectedValue(new Error('permission denied'));
    const invalidate = vi.fn();
    const modListProvider = { setModEnabled, invalidate };
    const channel = new FakeLogOutputChannel();

    await onModCheckboxChanged({ items: [[modNode('TestMod', false), 0]] }, modListProvider, channel);

    expect(channel.error).toHaveBeenCalledWith(
      '[modList.checkbox] error: Failed to update "TestMod". — permission denied');
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Failed to update "TestMod".');
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-mod row (the pinned Overwrite row sharing the tree)', async () => {
    const setModEnabled = vi.fn();
    const modListProvider = { setModEnabled, invalidate: vi.fn() };
    const overwriteNode = new ErrorNode('not a mod row');

    await onModCheckboxChanged({ items: [[overwriteNode, 1]] }, modListProvider, new FakeLogOutputChannel());

    expect(setModEnabled).not.toHaveBeenCalled();
  });
});
