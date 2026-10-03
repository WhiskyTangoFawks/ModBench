import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showErrorMessage, showWarningMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

import { TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor,
}));

import { onModCheckboxChanged } from '../modCheckboxHandler';
import { ModNode, OverwriteNode } from '../ModListProvider';
import { recordingReporter } from '../../test/surfacingDoubles';

beforeEach(() => { showErrorMessage.mockClear(); showWarningMessage.mockClear(); });

function modNode(name: string, enabled = true): ModNode {
  return new ModNode({ kind: 'mod', name, enabled });
}

describe('onModCheckboxChanged', () => {
  it('enables/disables the mod and does nothing else on success', async () => {
    const setModEnabled = vi.fn().mockResolvedValue(undefined);
    const markUnconfirmed = vi.fn();
    const forgetUnconfirmed = vi.fn();
    const modListProvider = { setModEnabled, markUnconfirmed, forgetUnconfirmed };

    const reporter = recordingReporter();

    await onModCheckboxChanged({ items: [[modNode('TestMod'), 1]] }, modListProvider, reporter);

    expect(setModEnabled).toHaveBeenCalledWith('TestMod', true);
    expect(markUnconfirmed).toHaveBeenCalledWith('TestMod', true);
    expect(forgetUnconfirmed).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('reports and forgets the mark so the checkbox shows the disk when the toggle fails', async () => {
    const setModEnabled = vi.fn().mockRejectedValue(new Error('permission denied'));
    const forgetUnconfirmed = vi.fn();
    const modListProvider = { setModEnabled, markUnconfirmed: vi.fn(), forgetUnconfirmed };

    const reporter = recordingReporter();

    await onModCheckboxChanged({ items: [[modNode('TestMod', false), 0]] }, modListProvider, reporter);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to update "TestMod".', detail: 'permission denied' },
    ]);
    expect(forgetUnconfirmed).toHaveBeenCalledWith('TestMod');
  });

  it('ignores a non-mod row (the pinned Overwrite row sharing the tree)', async () => {
    const setModEnabled = vi.fn();
    const modListProvider = { setModEnabled, markUnconfirmed: vi.fn(), forgetUnconfirmed: vi.fn() };
    const overwriteNode = new OverwriteNode([], 'MO2');

    await onModCheckboxChanged({ items: [[overwriteNode, 1]] }, modListProvider, recordingReporter());

    expect(setModEnabled).not.toHaveBeenCalled();
    expect(modListProvider.markUnconfirmed).not.toHaveBeenCalled();
  });
});
