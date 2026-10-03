import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  handlers, registerCommand, setPluginsEnabled,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    setPluginsEnabled: vi.fn(),
  };
});

vi.mock('../../pluginsCommands/plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pluginsCommands/plugins')>()),
  setPluginsEnabled,
}));

import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  commands: { registerCommand },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
}));

import { registerPluginEnableCommands } from '../pluginParticipationCommands';
import { PluginNode, ImplicitMasterNode } from '../PluginsTreeProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { accessTo } from '../../test/mo2/adapterOver';

const access = accessTo('/instance');

const marks = {
  isEnabled: (row: PluginNode) => row.plugin.enabled,
  markUnconfirmed: vi.fn(),
  forgetUnconfirmed: vi.fn(),
};

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const handler = present(handlers.get(commandId), `command not registered: ${commandId}`);
  return Promise.resolve(handler(...args));
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('modbench.plugin.enable / modbench.plugin.disable: the whole selection, one command per direction', () => {
  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const alpha = new PluginNode({ name: 'Alpha.esp', enabled: false }, 'SomeMod');
  const beta = new PluginNode({ name: 'Beta.esp', enabled: true }, 'SomeMod');
  const locked = new ImplicitMasterNode('Fallout4.esm', 'Data');

  it('enable applies to every selected plugin, whatever its own current state', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp', 'Beta.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter(), marks);
    await invoke('modbench.plugin.enable', alpha, [alpha, beta]);

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp', 'Beta.esp'], true);
  });

  it('disable applies to every selected plugin, whatever its own current state', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp', 'Beta.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter(), marks);
    await invoke('modbench.plugin.disable', beta, [alpha, beta]);

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp', 'Beta.esp'], false);
  });

  it('a right-click outside the selection takes just that row, not the rest of the view selection', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [beta], recordingReporter(), marks);
    await invoke('modbench.plugin.enable', alpha, undefined);

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp'], true);
  });

  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [alpha], recordingReporter(), marks);
    await invoke('modbench.plugin.enable');

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp'], true);
  });

  it('drops a locked row from the selection it writes', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter(), marks);
    await invoke('modbench.plugin.enable', alpha, [locked, alpha]);

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp'], true);
  });

  it('calls nothing and reports nothing for an empty selection', async () => {
    const reporter = recordingReporter();

    registerPluginEnableCommands(access, instance, () => [], reporter, marks);
    await invoke('modbench.plugin.enable');

    expect(setPluginsEnabled).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('says nothing when the whole selection lands', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });
    const reporter = recordingReporter();

    registerPluginEnableCommands(access, instance, () => [], reporter, marks);
    await invoke('modbench.plugin.enable', alpha);

    expect(reporter.reports).toEqual([]);
  });

  it('reports a gone plugin by name through the shared selectionOutcome reporter, once, while the rest land', async () => {
    setPluginsEnabled.mockResolvedValue({
      applied: true,
      outcome: { landed: ['Alpha.esp'], refused: [{ item: 'Beta.esp', reason: 'Plugin not found in plugins.txt: Beta.esp' }] },
    });
    const reporter = recordingReporter();

    registerPluginEnableCommands(access, instance, () => [], reporter, marks);
    await invoke('modbench.plugin.enable', alpha, [alpha, beta]);

    expect(reporter.selectionOutcomeCalls).toEqual([{
      message: 'Could not enable 1 of 2 plugins.',
      outcome: { landed: ['Alpha.esp'], refused: [{ item: 'Beta.esp', reason: 'Plugin not found in plugins.txt: Beta.esp' }] },
    }]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"Beta.esp" (Plugin not found in plugins.txt: Beta.esp)' },
    ]);
  });

  it('reports the whole selection refused, once, when plugins.txt cannot be written', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: false, refusal: 'ENOENT' });
    const reporter = recordingReporter();

    registerPluginEnableCommands(access, instance, () => [], reporter, marks);
    await invoke('modbench.plugin.disable', alpha);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to disable plugins.', detail: 'ENOENT' }]);
  });
});

describe('the enable and disable entries and the unconfirmed marks (common.md, Unconfirmed writes)', () => {
  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const alpha = new PluginNode({ name: 'Alpha.esp', enabled: false }, 'SomeMod');
  const beta = new PluginNode({ name: 'Beta.esp', enabled: true }, 'OtherMod');

  it('marks each plugin the gesture changes, by its row, before the write, and not one already in that state', async () => {
    const order: string[] = [];
    marks.markUnconfirmed.mockImplementation((row: PluginNode) => order.push(`mark ${row.plugin.name}`));
    setPluginsEnabled.mockImplementation(() => { order.push('write'); return Promise.resolve({ applied: true, outcome: { landed: ['Alpha.esp', 'Beta.esp'], refused: [] } }); });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter(), marks);
    await invoke('modbench.plugin.enable', alpha, [alpha, beta]);

    expect(order).toEqual(['mark Alpha.esp', 'write']);
    expect(marks.markUnconfirmed).toHaveBeenCalledWith(alpha, true);
    expect(marks.forgetUnconfirmed).not.toHaveBeenCalled();
  });

  it('forgets the mark of a plugin refused by name, and keeps the one that landed', async () => {
    setPluginsEnabled.mockResolvedValue({
      applied: true, outcome: { landed: ['Alpha.esp'], refused: [{ item: 'Gamma.esp', reason: 'gone' }] },
    });
    const gamma = new PluginNode({ name: 'Gamma.esp', enabled: false }, 'SomeMod');

    registerPluginEnableCommands(access, instance, () => [], recordingReporter(), marks);
    await invoke('modbench.plugin.enable', alpha, [alpha, gamma]);

    expect(marks.forgetUnconfirmed.mock.calls).toEqual([[gamma]]);
  });

  it('forgets every mark when the whole write is refused', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: false, refusal: 'ENOENT' });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter(), marks);
    await invoke('modbench.plugin.enable', alpha);

    expect(marks.forgetUnconfirmed.mock.calls).toEqual([[alpha]]);
  });
});
