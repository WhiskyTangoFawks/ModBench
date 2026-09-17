import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showErrorMessage, showWarningMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

import { TreeItem, TreeItemCollapsibleState, ThemeIcon, fakeUri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  TreeItem, TreeItemCollapsibleState, ThemeIcon,
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
    const invalidate = vi.fn();
    const modListProvider = { setModEnabled, invalidate };

    const reporter = recordingReporter();

    await onModCheckboxChanged({ items: [[modNode('TestMod'), 1]] }, modListProvider, reporter);

    expect(setModEnabled).toHaveBeenCalledWith('TestMod', true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('reports and invalidates so the checkbox resyncs when the toggle fails', async () => {
    const setModEnabled = vi.fn().mockRejectedValue(new Error('permission denied'));
    const invalidate = vi.fn();
    const modListProvider = { setModEnabled, invalidate };

    const reporter = recordingReporter();

    await onModCheckboxChanged({ items: [[modNode('TestMod', false), 0]] }, modListProvider, reporter);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to update "TestMod".', detail: 'permission denied' },
    ]);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-mod row (the pinned Overwrite row sharing the tree)', async () => {
    const setModEnabled = vi.fn();
    const modListProvider = { setModEnabled, invalidate: vi.fn() };
    const overwriteNode = new OverwriteNode(fakeUri('/instance/Overwrite'), 1);

    await onModCheckboxChanged({ items: [[overwriteNode, 1]] }, modListProvider, recordingReporter());

    expect(setModEnabled).not.toHaveBeenCalled();
  });
});
