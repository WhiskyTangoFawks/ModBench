import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onPluginCheckboxChanged } from '../pluginCheckboxHandler';
import { PluginNode } from '../PluginsTreeProvider';
import { RecordNode } from '../PluginTreeProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { accessTo } from '../../test/mo2/adapterOver';
import { progressSteps } from '../../test/recordedProgress';

let dir: string;
const pluginsTxt = () => join(dir, 'profiles', 'Default', 'plugins.txt');
const bytes = () => readFile(pluginsTxt(), 'utf8');
const mtime = async () => (await stat(pluginsTxt())).mtimeMs;
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

beforeEach(async () => {
  progressSteps.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'plugin-checkbox-'));
  await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
  await writeFile(pluginsTxt(), 'A.esp\r\n*B.esp\r\n');
  await utimes(pluginsTxt(), LONG_AGO, LONG_AGO);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const profile = () => 'Default';
const instance = { refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); } };
const toggled = (...items: [string, 0 | 1][]) => ({
  items: items.map(([name, state]) => [new PluginNode({ name, enabled: state === 0 }, 'SomeMod'), state] as [PluginNode, 0 | 1]),
});
const toggle = (event: ReturnType<typeof toggled>, reporter = recordingReporter()) =>
  onPluginCheckboxChanged(event, accessTo(dir), profile, reporter, instance);

describe('onPluginCheckboxChanged', () => {
  it('enables the plugin in plugins.txt and says nothing on a full landing', async () => {
    const reporter = recordingReporter();

    await toggle(toggled(['A.esp', 1]), reporter);

    expect(await bytes()).toBe('*A.esp\r\n*B.esp\r\n');
    expect(reporter.reports).toEqual([]);
  });

  it('lands boxes toggled to different states together', async () => {
    await toggle(toggled(['A.esp', 1], ['B.esp', 0]));

    expect(await bytes()).toBe('*A.esp\r\nB.esp\r\n');
  });

  it('says why when the whole toggle is refused', async () => {
    await rm(pluginsTxt());
    const reporter = recordingReporter();

    await toggle(toggled(['A.esp', 0]), reporter);

    expect(reporter.reports).toMatchObject([{ severity: 'error', message: 'Failed to disable plugins.' }]);
  });

  it('names a mixed-state toggle\'s failure generically, having no single direction to name', async () => {
    await rm(pluginsTxt());
    const reporter = recordingReporter();

    await toggle(toggled(['A.esp', 1], ['B.esp', 0]), reporter);

    expect(reporter.reports).toMatchObject([{ severity: 'error', message: 'Failed to update plugins.' }]);
  });

  it('names a refused row and why, and lands the one that can', async () => {
    const reporter = recordingReporter();

    await toggle(toggled(['A.esp', 1], ['Gone.esp', 1]), reporter);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"Gone.esp" (Plugin not found in plugins.txt: Gone.esp)' },
    ]);
    expect(await bytes()).toBe('*A.esp\r\n*B.esp\r\n');
  });

  it('ignores a non-plugin row (a record-tree row sharing the merged view)', async () => {
    const recordNode = new RecordNode(recordSummaryFixture(), 'Data');

    await onPluginCheckboxChanged({ items: [[recordNode, 1]] }, accessTo(dir), profile, recordingReporter(), instance);

    expect(await mtime()).toBe(LONG_AGO.getTime());
  });
});

describe('a check box ends when the read lands (common.md, A gesture that writes)', () => {
  it('shows the progress bar from the click until the read after the write lands', async () => {
    await toggle(toggled(['A.esp', 1]));

    expect(await bytes()).toBe('*A.esp\r\n*B.esp\r\n');
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('still ends on the read when the write is refused', async () => {
    await rm(pluginsTxt());

    await toggle(toggled(['A.esp', 1]));

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('opens no progress for a record row', async () => {
    await onPluginCheckboxChanged(
      { items: [[new RecordNode(recordSummaryFixture(), 'Data'), 1]] }, accessTo(dir), profile, recordingReporter(), instance);

    expect(progressSteps).toEqual([]);
  });
});
