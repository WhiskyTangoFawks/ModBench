import { describe, it, expect, vi, beforeEach } from 'vitest';

const { setPluginsParticipation } = vi.hoisted(() => ({ setPluginsParticipation: vi.fn() }));

vi.mock('../../pluginsCommands/plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pluginsCommands/plugins')>()),
  setPluginsParticipation,
}));

import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, uriFile, uriFrom,
} from '../../test/vscodeMock';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    ...fakeVscodeModule(),
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
    Uri: { file: uriFile, from: uriFrom },
    window: { withProgress: recordedWithProgress },
  };
});

import { onPluginCheckboxChanged } from '../pluginCheckboxHandler';
import { PluginNode } from '../PluginsTreeProvider';
import { RecordNode } from '../PluginTreeProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { accessTo } from '../../test/mo2/adapterOver';
import { progressSteps } from '../../test/recordedProgress';

beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

const profile = () => 'Default';
const access = accessTo('/instance');
const instance = { refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); } };

describe('onPluginCheckboxChanged', () => {
  it('enables the plugin and says nothing on a full landing', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['TestMod.esp'], refused: [] } });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      { items: [[new PluginNode({ name: 'TestMod.esp', enabled: true }, 'SomeMod'), 1]] },
      access, profile, reporter, instance,
    );

    expect(setPluginsParticipation).toHaveBeenCalledWith(access, 'Default', [{ name: 'TestMod.esp', enabled: true }]);
    expect(reporter.reports).toEqual([]);
  });

  it('several boxes toggled to the same state make one call to the core, one write', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['A.esp', 'B.esp'], refused: [] } });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      {
        items: [
          [new PluginNode({ name: 'A.esp', enabled: true }, 'SomeMod'), 1],
          [new PluginNode({ name: 'B.esp', enabled: true }, 'SomeMod'), 1],
        ],
      },
      access, profile, reporter, instance,
    );

    expect(setPluginsParticipation).toHaveBeenCalledOnce();
    expect(setPluginsParticipation).toHaveBeenCalledWith(
      access, 'Default', [{ name: 'A.esp', enabled: true }, { name: 'B.esp', enabled: true }],
    );
  });

  it('boxes toggled to different states still make one call to the core, one write', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['A.esp', 'B.esp'], refused: [] } });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      {
        items: [
          [new PluginNode({ name: 'A.esp', enabled: false }, 'SomeMod'), 1],
          [new PluginNode({ name: 'B.esp', enabled: true }, 'SomeMod'), 0],
        ],
      },
      access, profile, reporter, instance,
    );

    expect(setPluginsParticipation).toHaveBeenCalledOnce();
    expect(setPluginsParticipation).toHaveBeenCalledWith(
      access, 'Default', [{ name: 'A.esp', enabled: true }, { name: 'B.esp', enabled: false }],
    );
  });

  it('says why when the whole toggle is refused', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: false, refusal: 'disk full' });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      { items: [[new PluginNode({ name: 'TestMod.esp', enabled: false }, 'SomeMod'), 0]] },
      access, profile, reporter, instance,
    );

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to disable plugins.', detail: 'disk full' }]);
  });

  it('names a mixed-state toggle\'s failure generically, having no single direction to name', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: false, refusal: 'disk full' });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      {
        items: [
          [new PluginNode({ name: 'A.esp', enabled: false }, 'SomeMod'), 1],
          [new PluginNode({ name: 'B.esp', enabled: true }, 'SomeMod'), 0],
        ],
      },
      access, profile, reporter, instance,
    );

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to update plugins.', detail: 'disk full' }]);
  });

  it('names a refused row and why, and not the one that landed', async () => {
    setPluginsParticipation.mockResolvedValue({
      applied: true,
      outcome: { landed: ['A.esp'], refused: [{ item: 'B.esp', reason: 'Plugin not found in plugins.txt: B.esp' }] },
    });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      {
        items: [
          [new PluginNode({ name: 'A.esp', enabled: false }, 'SomeMod'), 1],
          [new PluginNode({ name: 'B.esp', enabled: false }, 'SomeMod'), 1],
        ],
      },
      access, profile, reporter, instance,
    );

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"B.esp" (Plugin not found in plugins.txt: B.esp)' },
    ]);
  });

  it('ignores a non-plugin row (a record-tree row sharing the merged view)', async () => {
    const recordNode = new RecordNode(recordSummaryFixture(), 'Data');

    await onPluginCheckboxChanged({ items: [[recordNode, 1]] }, access, profile, recordingReporter(), instance);

    expect(setPluginsParticipation).not.toHaveBeenCalled();
  });
});

describe('a check box ends when the read lands (common.md, A gesture that writes)', () => {
  const a = new PluginNode({ name: 'A.esp', enabled: false }, 'ModOne');

  it('shows the progress bar from the click until the read after the write lands', async () => {
    setPluginsParticipation.mockImplementation(() => {
      progressSteps.push('write plugins.txt');
      return Promise.resolve({ applied: true, outcome: { landed: ['A.esp'], refused: [] } });
    });

    await onPluginCheckboxChanged({ items: [[a, 1]] }, access, profile, recordingReporter(), instance);

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'write plugins.txt',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('still ends on the read when the write is refused', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: false, refusal: 'disk full' });

    await onPluginCheckboxChanged({ items: [[a, 1]] }, access, profile, recordingReporter(), instance);

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('opens no progress for a record row', async () => {
    await onPluginCheckboxChanged(
      { items: [[new RecordNode(recordSummaryFixture(), 'Data'), 1]] }, access, profile, recordingReporter(), instance);

    expect(progressSteps).toEqual([]);
  });
});
