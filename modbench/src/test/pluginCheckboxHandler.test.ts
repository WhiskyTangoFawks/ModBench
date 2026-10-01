import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { setPluginsParticipation } = vi.hoisted(() => ({ setPluginsParticipation: vi.fn() }));

vi.mock('../pluginsCommands/plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pluginsCommands/plugins')>()),
  setPluginsParticipation,
}));

import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, uriFile, uriFrom,
} from './vscodeMock';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile, from: uriFrom },
}));

import { onPluginCheckboxChanged } from '../pluginCheckboxHandler';
import { PluginNode, PluginsTreeProvider } from '../plugins/PluginsTreeProvider';
import { RecordNode } from '../plugins/PluginTreeProvider';
import { recordingReporter } from './surfacingDoubles';
import { recordSummaryFixture } from '../client/test/fixtures';
import { FakeInstance } from './mo2/fakeInstance';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { expectInstanceOf } from './expectInstanceOf';
import { accessTo } from './mo2/adapterOver';

beforeEach(() => { vi.clearAllMocks(); });

const profile = () => 'Default';
const access = accessTo('/instance');
const marks = { markUnconfirmed: vi.fn(), forgetUnconfirmed: vi.fn() };

describe('onPluginCheckboxChanged', () => {
  it('enables the plugin and says nothing on a full landing', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['TestMod.esp'], refused: [] } });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      { items: [[new PluginNode({ name: 'TestMod.esp', enabled: true }, 'SomeMod'), 1]] },
      access, profile, reporter, marks,
    );

    expect(setPluginsParticipation).toHaveBeenCalledWith(access, 'Default', [{ name: 'TestMod.esp', enabled: true }]);
    expect(reporter.reports).toEqual([]);
  });

  // The core requirement this handler exists to satisfy: several boxes toggled in one VS Code
  // event reach the core in one splice, not one write per row.
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
      access, profile, reporter, marks,
    );

    expect(setPluginsParticipation).toHaveBeenCalledOnce();
    expect(setPluginsParticipation).toHaveBeenCalledWith(
      access, 'Default', [{ name: 'A.esp', enabled: true }, { name: 'B.esp', enabled: true }],
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
          [new PluginNode({ name: 'A.esp', enabled: false }, 'SomeMod'), 1],
          [new PluginNode({ name: 'B.esp', enabled: true }, 'SomeMod'), 0],
        ],
      },
      access, profile, reporter, marks,
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
      access, profile, reporter, marks,
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
      access, profile, reporter, marks,
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
      access, profile, reporter, marks,
    );

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"B.esp" (Plugin not found in plugins.txt: B.esp)' },
    ]);
  });

  it('ignores a non-plugin row (a record-tree row sharing the merged view)', async () => {
    const recordNode = new RecordNode(recordSummaryFixture(), 'Data');

    await onPluginCheckboxChanged({ items: [[recordNode, 1]] }, access, profile, recordingReporter(), marks);

    expect(setPluginsParticipation).not.toHaveBeenCalled();
  });
});

describe('the check box and the unconfirmed marks', () => {
  beforeEach(() => { marks.markUnconfirmed.mockClear(); marks.forgetUnconfirmed.mockClear(); });

  it('marks each toggled row by its (origin, filename) before the write, and keeps the marks when it lands', async () => {
    setPluginsParticipation.mockImplementation(() => {
      expect(marks.markUnconfirmed).toHaveBeenCalledTimes(2);
      return Promise.resolve({ applied: true, outcome: { landed: ['A.esp', 'B.esp'], refused: [] } });
    });
    const a = new PluginNode({ name: 'A.esp', enabled: false }, 'ModOne');
    const b = new PluginNode({ name: 'B.esp', enabled: true }, 'ModTwo');

    await onPluginCheckboxChanged({ items: [[a, 1], [b, 0]] }, access, profile, recordingReporter(), marks);

    expect(marks.markUnconfirmed.mock.calls).toEqual([[a, true], [b, false]]);
    expect(marks.forgetUnconfirmed).not.toHaveBeenCalled();
  });

  it('forgets every mark when the whole toggle is refused', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: false, refusal: 'disk full' });
    const a = new PluginNode({ name: 'A.esp', enabled: false }, 'ModOne');

    await onPluginCheckboxChanged({ items: [[a, 1]] }, access, profile, recordingReporter(), marks);

    expect(marks.forgetUnconfirmed.mock.calls).toEqual([[a]]);
  });

  it('forgets the mark of a refused row alone', async () => {
    setPluginsParticipation.mockResolvedValue({
      applied: true, outcome: { landed: ['A.esp'], refused: [{ item: 'B.esp', reason: 'gone' }] },
    });
    const a = new PluginNode({ name: 'A.esp', enabled: false }, 'ModOne');
    const b = new PluginNode({ name: 'B.esp', enabled: false }, 'ModOne');

    await onPluginCheckboxChanged({ items: [[a, 1], [b, 1]] }, access, profile, recordingReporter(), marks);

    expect(marks.forgetUnconfirmed.mock.calls).toEqual([[b]]);
  });

  it('marks no record row', async () => {
    await onPluginCheckboxChanged(
      { items: [[new RecordNode(recordSummaryFixture(), 'Data'), 1]] }, access, profile, recordingReporter(), marks);

    expect(marks.markUnconfirmed).not.toHaveBeenCalled();
  });
});

// plugins.md, The view; ADR-0015 invariant 2: the rows follow the Instance loader's next value.
describe('a check-box enable and the Plugins rows', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const valueWith = (enabled: boolean) => instanceValueFixture({
    plugins: [{ name: 'TestMod.esp', path: '/data/TestMod.esp', origin: 'SomeMod', slot: 0, enabled, winning: true }],
  });

  async function firstRow(tree: PluginsTreeProvider) {
    const [row] = await tree.getChildren();
    return expectInstanceOf(row, PluginNode);
  }

  it('shows the written state at once and the disk\'s once its value lands', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['TestMod.esp'], refused: [] } });
    const instance = new FakeInstance(valueWith(false));
    const tree = new PluginsTreeProvider({ instance, source: { reorderPlugins: () => Promise.resolve() } });
    const row = await firstRow(tree);

    await onPluginCheckboxChanged({ items: [[row, TreeItemCheckboxState.Checked]] }, access, profile, recordingReporter(), tree);

    expect((await firstRow(tree)).checkboxState).toBe(TreeItemCheckboxState.Checked);

    instance.publish(valueWith(true));

    expect((await firstRow(tree)).checkboxState).toBe(TreeItemCheckboxState.Checked);
    vi.advanceTimersByTime(1000);
    expect(tree.getTreeItem(await firstRow(tree)).iconPath).toBeUndefined();
  });

  it('a refused write shows the disk\'s state at once, with no mark', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: false, refusal: 'disk full' });
    const instance = new FakeInstance(valueWith(false));
    const tree = new PluginsTreeProvider({ instance, source: { reorderPlugins: () => Promise.resolve() } });
    const row = await firstRow(tree);

    await onPluginCheckboxChanged({ items: [[row, TreeItemCheckboxState.Checked]] }, access, profile, recordingReporter(), tree);
    vi.advanceTimersByTime(1000);

    const shown = await firstRow(tree);
    expect(shown.checkboxState).toBe(TreeItemCheckboxState.Unchecked);
    expect(tree.getTreeItem(shown).tooltip).not.toBe('Written; waiting for the disk to confirm');
  });
});
