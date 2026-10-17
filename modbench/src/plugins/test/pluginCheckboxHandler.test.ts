import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { PluginNode } from '../pluginRows';
import { recordRow } from './browserRows';
import { recordingReporter } from '../../test/surfacingDoubles';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, refusing, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { progressSteps } from '../../test/recordedProgress';

beforeEach(() => {
  progressSteps.length = 0;
});

const REFUSED: InstanceAnswers = { refusals: refusing('changePluginOrder', 'ENOENT: no plugins.txt') };
const fake = (answers: InstanceAnswers = {}) =>
  fakeInstanceAdapter(readingFixture({ pluginOrder: [{ name: 'A.esp', enabled: false }, { name: 'B.esp', enabled: true }] }), answers);
const profile = () => 'Default';
const instance = { refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); } };
const toggled = (...items: [string, 0 | 1][]) => ({
  items: items.map(([name, state]) => [new PluginNode({ name, enabled: state === 0 }, 'SomeMod'), state] as [PluginNode, 0 | 1]),
});
const toggle = (event: ReturnType<typeof toggled>, adapter = fake(), reporter = recordingReporter()) =>
  onPluginCheckboxChanged(event, pluginCommandsWith(adapter.adapter), profile, reporter, instance);
const enabling = (...pairs: [string, boolean][]) =>
  [{ verb: 'changePluginOrder', profile: 'Default', changes: pairs.map(([plugin, enabled]) => ({ kind: 'enable', plugin, enabled })) }];

describe('onPluginCheckboxChanged', () => {
  it('hands the adapter the enable of the plugin and says nothing on a full landing', async () => {
    const adapter = fake();
    const reporter = recordingReporter();

    await toggle(toggled(['A.esp', 1]), adapter, reporter);

    expect(adapter.calls).toEqual(enabling(['A.esp', true]));
    expect(reporter.reports).toEqual([]);
  });

  it('lands boxes toggled to different states together', async () => {
    const adapter = fake();

    await toggle(toggled(['A.esp', 1], ['B.esp', 0]), adapter);

    expect(adapter.calls).toEqual(enabling(['A.esp', true], ['B.esp', false]));
  });

  it.each<[string, [string, 0 | 1][], string]>([
    ['says why when the whole toggle is refused', [['A.esp', 0]], 'Failed to disable plugins.'],
    ['names a mixed-state toggle\'s failure generically, having no single direction to name', [['A.esp', 1], ['B.esp', 0]], 'Failed to update plugins.'],
  ])('%s', async (_, items, message) => {
    const reporter = recordingReporter();

    await toggle(toggled(...items), fake(REFUSED), reporter);

    expect(reporter.reports).toMatchObject([{ severity: 'error', message }]);
  });

  it('names a refused row and why, and lands the one that can', async () => {
    const adapter = fake();
    const reporter = recordingReporter();

    await toggle(toggled(['A.esp', 1], ['Gone.esp', 1]), adapter, reporter);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"Gone.esp" (Plugin not found in plugins.txt: Gone.esp)' },
    ]);
    expect(adapter.calls).toEqual(enabling(['A.esp', true]));
  });

  it('ignores a non-plugin row (a record-tree row sharing the merged view)', async () => {
    const adapter = fake();
    const recordNode = await recordRow(recordSummaryFixture(), 'Data/');

    await onPluginCheckboxChanged({ items: [[recordNode, 1]] }, pluginCommandsWith(adapter.adapter), profile, recordingReporter(), instance);

    expect(adapter.calls).toEqual([]);
  });
});

describe('a check box ends when the read lands (common.md, A gesture that writes)', () => {
  const ENDS_ON_THE_READ = [
    'progress opens on modbench.pluginListTree',
    'Instance loader: read every file again',
    'progress closes',
  ];

  it('shows the progress bar from the click until the read after the write lands', async () => {
    await toggle(toggled(['A.esp', 1]));

    expect(progressSteps).toEqual(ENDS_ON_THE_READ);
  });

  it('still ends on the read when the write is refused', async () => {
    await toggle(toggled(['A.esp', 1]), fake(REFUSED));

    expect(progressSteps).toEqual(ENDS_ON_THE_READ);
  });

  it('opens no progress for a record row', async () => {
    await onPluginCheckboxChanged(
      { items: [[await recordRow(recordSummaryFixture(), 'Data/'), 1]] }, pluginCommandsWith(fake().adapter), profile, recordingReporter(), instance);

    expect(progressSteps).toEqual([]);
  });
});
