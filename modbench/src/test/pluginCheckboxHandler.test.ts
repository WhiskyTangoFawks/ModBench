import { describe, it, expect, vi, beforeEach } from 'vitest';

// onPluginCheckboxChanged is extracted from registerPluginListView so a unit test can reach it,
// the same way modCheckboxHandler.test.ts reaches onModCheckboxChanged.
const { showErrorMessage, showWarningMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

import { TreeItem, TreeItemCollapsibleState, EventEmitter, uriFrom } from './vscodeMock';

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  TreeItem, TreeItemCollapsibleState, EventEmitter,
  Uri: { from: uriFrom },
}));

import { onPluginCheckboxChanged } from '../pluginCheckboxHandler';
import { PluginNode } from '../plugins/PluginsTreeProvider';
import { RecordNode } from '../plugins/PluginTreeProvider';
import { FakeLogOutputChannel } from './fakeOutputChannel';
import { recordSummaryFixture } from '../client/test/fixtures';

beforeEach(() => { showErrorMessage.mockClear(); showWarningMessage.mockClear(); });

describe('onPluginCheckboxChanged', () => {
  it('enables/disables the plugin and does nothing else on success', async () => {
    const setPluginEnabled = vi.fn().mockResolvedValue(undefined);
    const invalidate = vi.fn();
    const provider = { setPluginEnabled, invalidate };
    const channel = new FakeLogOutputChannel();

    await onPluginCheckboxChanged(
      { items: [[new PluginNode({ name: 'TestMod.esp', enabled: true }), 1]] }, provider, channel,
    );

    expect(setPluginEnabled).toHaveBeenCalledWith('TestMod.esp', true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('reports and invalidates so the checkbox resyncs when the toggle fails', async () => {
    const setPluginEnabled = vi.fn().mockRejectedValue(new Error('disk full'));
    const invalidate = vi.fn();
    const provider = { setPluginEnabled, invalidate };
    const channel = new FakeLogOutputChannel();

    await onPluginCheckboxChanged(
      { items: [[new PluginNode({ name: 'TestMod.esp', enabled: false }), 0]] }, provider, channel,
    );

    expect(channel.error).toHaveBeenCalledWith(
      '[pluginListTree.checkbox] error: Failed to update "TestMod.esp". — disk full');
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Failed to update "TestMod.esp".');
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-plugin row (a record-tree row sharing the merged view)', async () => {
    const setPluginEnabled = vi.fn();
    const provider = { setPluginEnabled, invalidate: vi.fn() };
    const recordNode = new RecordNode(recordSummaryFixture());

    await onPluginCheckboxChanged({ items: [[recordNode, 1]] }, provider, new FakeLogOutputChannel());

    expect(setPluginEnabled).not.toHaveBeenCalled();
  });
});
