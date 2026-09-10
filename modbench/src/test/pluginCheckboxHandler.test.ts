import { describe, it, expect, vi, beforeEach } from 'vitest';

// onPluginCheckboxChanged is extracted from registerPluginListView so a unit test can reach it,
// the same way modCheckboxHandler.test.ts reaches onModCheckboxChanged.
const { showErrorMessage, showWarningMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));
vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
}));

import { onPluginCheckboxChanged } from '../pluginCheckboxHandler';
import type { PluginListNode } from '../plugins/PluginsTreeProvider';

beforeEach(() => { showErrorMessage.mockClear(); showWarningMessage.mockClear(); });

function fakeChannel() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function pluginNode(name: string): PluginListNode {
  return { kind: 'plugin', plugin: { name } } as unknown as PluginListNode;
}

describe('onPluginCheckboxChanged', () => {
  it('enables/disables the plugin and does nothing else on success', async () => {
    const setPluginEnabled = vi.fn().mockResolvedValue(undefined);
    const invalidate = vi.fn();
    const provider = { setPluginEnabled, invalidate } as never;
    const channel = fakeChannel();

    await onPluginCheckboxChanged(
      { items: [[pluginNode('TestMod.esp'), 1]] } as never, provider, channel as never,
    );

    expect(setPluginEnabled).toHaveBeenCalledWith('TestMod.esp', true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('reports and invalidates so the checkbox resyncs when the toggle fails', async () => {
    const setPluginEnabled = vi.fn().mockRejectedValue(new Error('disk full'));
    const invalidate = vi.fn();
    const provider = { setPluginEnabled, invalidate } as never;
    const channel = fakeChannel();

    await onPluginCheckboxChanged(
      { items: [[pluginNode('TestMod.esp'), 0]] } as never, provider, channel as never,
    );

    expect(channel.error).toHaveBeenCalledWith(
      '[pluginListTree.checkbox] error: Failed to update "TestMod.esp". — disk full');
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Failed to update "TestMod.esp".');
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-plugin row (a record-tree row sharing the merged view)', async () => {
    const setPluginEnabled = vi.fn();
    const provider = { setPluginEnabled, invalidate: vi.fn() } as never;
    const recordNode = { kind: 'record' } as never;

    await onPluginCheckboxChanged({ items: [[recordNode, 1]] } as never, provider, fakeChannel() as never);

    expect(setPluginEnabled).not.toHaveBeenCalled();
  });
});
