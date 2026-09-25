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
  const alpha = new PluginNode({ name: 'Alpha.esp', enabled: false });
  const beta = new PluginNode({ name: 'Beta.esp', enabled: true });
  const locked = new ImplicitMasterNode('Fallout4.esm');

  it('enable applies to every selected plugin, whatever its own current state', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp', 'Beta.esp'], refused: [] } });

    registerPluginEnableCommands('/instance', instance, () => [], recordingReporter());
    await invoke('modbench.plugin.enable', alpha, [alpha, beta]);

    expect(setPluginsEnabled).toHaveBeenCalledWith('/instance', 'Default', ['Alpha.esp', 'Beta.esp'], true);
  });

  it('disable applies to every selected plugin, whatever its own current state', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp', 'Beta.esp'], refused: [] } });

    registerPluginEnableCommands('/instance', instance, () => [], recordingReporter());
    await invoke('modbench.plugin.disable', beta, [alpha, beta]);

    expect(setPluginsEnabled).toHaveBeenCalledWith('/instance', 'Default', ['Alpha.esp', 'Beta.esp'], false);
  });

  it('a right-click outside the selection takes just that row, not the rest of the view selection', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });

    registerPluginEnableCommands('/instance', instance, () => [beta], recordingReporter());
    await invoke('modbench.plugin.enable', alpha, undefined);

    expect(setPluginsEnabled).toHaveBeenCalledWith('/instance', 'Default', ['Alpha.esp'], true);
  });

  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });

    registerPluginEnableCommands('/instance', instance, () => [alpha], recordingReporter());
    await invoke('modbench.plugin.enable');

    expect(setPluginsEnabled).toHaveBeenCalledWith('/instance', 'Default', ['Alpha.esp'], true);
  });

  // plugins.md, "the locked rows are never part of the Argument": a plugin the game loads with no
  // line drops out of a mixed selection before it reaches the write.
  it('drops a locked row from the selection it writes', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });

    registerPluginEnableCommands('/instance', instance, () => [], recordingReporter());
    await invoke('modbench.plugin.enable', alpha, [locked, alpha]);

    expect(setPluginsEnabled).toHaveBeenCalledWith('/instance', 'Default', ['Alpha.esp'], true);
  });

  it('calls nothing and reports nothing for an empty selection', async () => {
    const reporter = recordingReporter();

    registerPluginEnableCommands('/instance', instance, () => [], reporter);
    await invoke('modbench.plugin.enable');

    expect(setPluginsEnabled).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('says nothing when the whole selection lands', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });
    const reporter = recordingReporter();

    registerPluginEnableCommands('/instance', instance, () => [], reporter);
    await invoke('modbench.plugin.enable', alpha);

    expect(reporter.reports).toEqual([]);
  });

  it('reports a gone plugin by name through the shared selectionOutcome reporter, once, while the rest land', async () => {
    setPluginsEnabled.mockResolvedValue({
      applied: true,
      outcome: { landed: ['Alpha.esp'], refused: [{ item: 'Beta.esp', reason: 'Plugin not found in plugins.txt: Beta.esp' }] },
    });
    const reporter = recordingReporter();

    registerPluginEnableCommands('/instance', instance, () => [], reporter);
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

    registerPluginEnableCommands('/instance', instance, () => [], reporter);
    await invoke('modbench.plugin.disable', alpha);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to disable plugins.', detail: 'ENOENT' }]);
  });
});
