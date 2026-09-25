import { describe, it, expect, vi, beforeEach } from 'vitest';

const { setPluginsParticipation } = vi.hoisted(() => ({ setPluginsParticipation: vi.fn() }));

vi.mock('../pluginsCommands/plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pluginsCommands/plugins')>()),
  setPluginsParticipation,
}));

import { TreeItem, TreeItemCollapsibleState, EventEmitter, uriFrom } from './vscodeMock';

vi.mock('vscode', () => ({
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  TreeItem, TreeItemCollapsibleState, EventEmitter,
  Uri: { from: uriFrom },
}));

import { onPluginCheckboxChanged } from '../pluginCheckboxHandler';
import { PluginNode } from '../plugins/PluginsTreeProvider';
import { RecordNode } from '../plugins/PluginTreeProvider';
import { recordingReporter } from './surfacingDoubles';
import { recordSummaryFixture } from '../client/test/fixtures';

beforeEach(() => { vi.clearAllMocks(); });

const profile = () => 'Default';

describe('onPluginCheckboxChanged', () => {
  it('enables the plugin and says nothing on a full landing', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['TestMod.esp'], refused: [] } });
    const invalidate = vi.fn();
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      { items: [[new PluginNode({ name: 'TestMod.esp', enabled: true }), 1]] },
      '/instance', profile, reporter, invalidate,
    );

    expect(setPluginsParticipation).toHaveBeenCalledWith('/instance', 'Default', [{ name: 'TestMod.esp', enabled: true }]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  // The core requirement this handler exists to satisfy: several boxes toggled in one VS Code
  // event reach the core in one splice, not one write per row.
  it('several boxes toggled to the same state make one call to the core, one write', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['A.esp', 'B.esp'], refused: [] } });
    const invalidate = vi.fn();
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      {
        items: [
          [new PluginNode({ name: 'A.esp', enabled: true }), 1],
          [new PluginNode({ name: 'B.esp', enabled: true }), 1],
        ],
      },
      '/instance', profile, reporter, invalidate,
    );

    expect(setPluginsParticipation).toHaveBeenCalledOnce();
    expect(setPluginsParticipation).toHaveBeenCalledWith(
      '/instance', 'Default', [{ name: 'A.esp', enabled: true }, { name: 'B.esp', enabled: true }],
    );
  });

  // The rival this guards against: grouping by target state and issuing one splice per group,
  // which turns a single mixed-state VS Code event into two writes and two reports.
  it('boxes toggled to different states still make one call to the core, one write', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['A.esp', 'B.esp'], refused: [] } });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      {
        items: [
          [new PluginNode({ name: 'A.esp', enabled: false }), 1],
          [new PluginNode({ name: 'B.esp', enabled: true }), 0],
        ],
      },
      '/instance', profile, reporter, vi.fn(),
    );

    expect(setPluginsParticipation).toHaveBeenCalledOnce();
    expect(setPluginsParticipation).toHaveBeenCalledWith(
      '/instance', 'Default', [{ name: 'A.esp', enabled: true }, { name: 'B.esp', enabled: false }],
    );
  });

  it('reports and resyncs the tree when the whole toggle is refused', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: false, refusal: 'disk full' });
    const invalidate = vi.fn();
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      { items: [[new PluginNode({ name: 'TestMod.esp', enabled: false }), 0]] },
      '/instance', profile, reporter, invalidate,
    );

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to disable plugins.', detail: 'disk full' }]);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('names a mixed-state toggle\'s failure generically, having no single direction to name', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: false, refusal: 'disk full' });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      {
        items: [
          [new PluginNode({ name: 'A.esp', enabled: false }), 1],
          [new PluginNode({ name: 'B.esp', enabled: true }), 0],
        ],
      },
      '/instance', profile, reporter, vi.fn(),
    );

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to update plugins.', detail: 'disk full' }]);
  });

  it('resyncs only for a refused row, naming it, while a landed one needs no resync', async () => {
    setPluginsParticipation.mockResolvedValue({
      applied: true,
      outcome: { landed: ['A.esp'], refused: [{ item: 'B.esp', reason: 'Plugin not found in plugins.txt: B.esp' }] },
    });
    const invalidate = vi.fn();
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      {
        items: [
          [new PluginNode({ name: 'A.esp', enabled: false }), 1],
          [new PluginNode({ name: 'B.esp', enabled: false }), 1],
        ],
      },
      '/instance', profile, reporter, invalidate,
    );

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"B.esp" (Plugin not found in plugins.txt: B.esp)' },
    ]);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-plugin row (a record-tree row sharing the merged view)', async () => {
    const recordNode = new RecordNode(recordSummaryFixture());

    await onPluginCheckboxChanged({ items: [[recordNode, 1]] }, '/instance', profile, recordingReporter(), vi.fn());

    expect(setPluginsParticipation).not.toHaveBeenCalled();
  });
});
