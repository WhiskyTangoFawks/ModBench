import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('onPluginCheckboxChanged', () => {
  it('enables the plugin and says nothing on a full landing', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['TestMod.esp'], refused: [] } });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      { items: [[new PluginNode({ name: 'TestMod.esp', enabled: true }, 'SomeMod'), 1]] },
      accessTo('/instance'), profile, reporter,
    );

    expect(setPluginsParticipation).toHaveBeenCalledWith('/instance', 'Default', [{ name: 'TestMod.esp', enabled: true }]);
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
      accessTo('/instance'), profile, reporter,
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
          [new PluginNode({ name: 'A.esp', enabled: false }, 'SomeMod'), 1],
          [new PluginNode({ name: 'B.esp', enabled: true }, 'SomeMod'), 0],
        ],
      },
      accessTo('/instance'), profile, reporter,
    );

    expect(setPluginsParticipation).toHaveBeenCalledOnce();
    expect(setPluginsParticipation).toHaveBeenCalledWith(
      '/instance', 'Default', [{ name: 'A.esp', enabled: true }, { name: 'B.esp', enabled: false }],
    );
  });

  it('says why when the whole toggle is refused', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: false, refusal: 'disk full' });
    const reporter = recordingReporter();

    await onPluginCheckboxChanged(
      { items: [[new PluginNode({ name: 'TestMod.esp', enabled: false }, 'SomeMod'), 0]] },
      accessTo('/instance'), profile, reporter,
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
      accessTo('/instance'), profile, reporter,
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
      accessTo('/instance'), profile, reporter,
    );

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"B.esp" (Plugin not found in plugins.txt: B.esp)' },
    ]);
  });

  it('ignores a non-plugin row (a record-tree row sharing the merged view)', async () => {
    const recordNode = new RecordNode(recordSummaryFixture(), 'Data');

    await onPluginCheckboxChanged({ items: [[recordNode, 1]] }, accessTo('/instance'), profile, recordingReporter());

    expect(setPluginsParticipation).not.toHaveBeenCalled();
  });
});

// plugins.md, The view; ADR-0015 invariant 2: the check box writes plugins.txt and returns, and the
// rows follow the Instance loader's next value, never the write's own say-so.
describe('a check-box enable and the Plugins rows', () => {
  const valueWith = (enabled: boolean) => instanceValueFixture({
    plugins: [{ name: 'TestMod.esp', path: '/data/TestMod.esp', origin: 'SomeMod', slot: 0, enabled, winning: true }],
  });

  async function checkedState(tree: PluginsTreeProvider) {
    const [row] = await tree.getChildren();
    return expectInstanceOf(row, PluginNode).checkboxState;
  }

  it('leaves the rows as they are until the next instance value arrives, then shows it', async () => {
    setPluginsParticipation.mockResolvedValue({ applied: true, outcome: { landed: ['TestMod.esp'], refused: [] } });
    const instance = new FakeInstance(valueWith(false));
    const tree = new PluginsTreeProvider({ instance, source: { reorderPlugins: () => Promise.resolve() } });
    const [row] = await tree.getChildren();
    let changes = 0;
    tree.onDidChangeTreeData(() => { changes++; });

    await onPluginCheckboxChanged(
      { items: [[expectInstanceOf(row, PluginNode), TreeItemCheckboxState.Checked]] }, accessTo('/instance'), profile, recordingReporter());

    expect(changes).toBe(0);
    expect(await checkedState(tree)).toBe(TreeItemCheckboxState.Unchecked);

    instance.publish(valueWith(true));

    expect(changes).toBeGreaterThan(0);
    expect(await checkedState(tree)).toBe(TreeItemCheckboxState.Checked);
  });
});
