import { describe, it, expect, vi, beforeEach } from 'vitest';

// #655: onModCheckboxChanged already had its own unit seam (a named, standalone function) before
// this ticket, but no test ever reached it — the ADR-0026 checkbox-failure path (log/notify/
// invalidate) had zero coverage on either loadout tree. See pluginCheckboxHandler.test.ts for
// its Editing-side twin.
const { showErrorMessage, showWarningMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));
vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
}));

import { onModCheckboxChanged } from './modCheckboxHandler';
import type { ModNode } from './ModListProvider';

beforeEach(() => { showErrorMessage.mockClear(); showWarningMessage.mockClear(); });

function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function modNode(name: string): ModNode {
  return { kind: 'mod', mod: { name } } as unknown as ModNode;
}

describe('onModCheckboxChanged', () => {
  it('enables/disables the mod and does nothing else on success', async () => {
    const setModEnabled = vi.fn().mockResolvedValue(undefined);
    const invalidate = vi.fn();
    const modListProvider = { setModEnabled, invalidate } as never;
    const channel = fakeChannel();

    await onModCheckboxChanged({ items: [[modNode('TestMod'), 1]] } as never, modListProvider, channel as never);

    expect(setModEnabled).toHaveBeenCalledWith('TestMod', true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('reports and invalidates so the checkbox resyncs when the toggle fails', async () => {
    const setModEnabled = vi.fn().mockRejectedValue(new Error('permission denied'));
    const invalidate = vi.fn();
    const modListProvider = { setModEnabled, invalidate } as never;
    const channel = fakeChannel();

    await onModCheckboxChanged({ items: [[modNode('TestMod'), 0]] } as never, modListProvider, channel as never);

    expect(channel.error).toHaveBeenCalledWith(
      '[modList.checkbox] error: Failed to update "TestMod". — permission denied');
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Failed to update "TestMod".');
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-mod row (the pinned Overwrite row sharing the tree)', async () => {
    const setModEnabled = vi.fn();
    const modListProvider = { setModEnabled, invalidate: vi.fn() } as never;
    const overwriteNode = { kind: 'overwrite' } as never;

    await onModCheckboxChanged({ items: [[overwriteNode, 1]] } as never, modListProvider, fakeChannel() as never);

    expect(setModEnabled).not.toHaveBeenCalled();
  });
});
