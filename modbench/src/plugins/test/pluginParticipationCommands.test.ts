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

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand },
    window: { withProgress: recordedWithProgress },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  };
});

import { registerPluginEnableCommands } from '../pluginParticipationCommands';
import { PluginNode, ImplicitMasterNode } from '../PluginsTreeProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { accessTo } from '../../test/mo2/adapterOver';
import { progressSteps } from '../../test/recordedProgress';

const access = accessTo('/instance');

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const handler = present(handlers.get(commandId), `command not registered: ${commandId}`);
  return Promise.resolve(handler(...args));
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  progressSteps.length = 0;
});

describe('modbench.plugin.enable / modbench.plugin.disable: the whole selection, one command per direction', () => {
  const instance = {
    value: instanceValueFixture({ activeProfile: 'Default' }),
    refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
  };
  const alpha = new PluginNode({ name: 'Alpha.esp', enabled: false }, 'SomeMod');
  const beta = new PluginNode({ name: 'Beta.esp', enabled: true }, 'SomeMod');
  const locked = new ImplicitMasterNode('Fallout4.esm', 'Data');

  it('enable applies to every selected plugin, whatever its own current state', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp', 'Beta.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter());
    await invoke('modbench.plugin.enable', alpha, [alpha, beta]);

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp', 'Beta.esp'], true);
  });

  it('disable applies to every selected plugin, whatever its own current state', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp', 'Beta.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter());
    await invoke('modbench.plugin.disable', beta, [alpha, beta]);

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp', 'Beta.esp'], false);
  });

  it('a right-click outside the selection takes just that row, not the rest of the view selection', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [beta], recordingReporter());
    await invoke('modbench.plugin.enable', alpha, undefined);

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp'], true);
  });

  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [alpha], recordingReporter());
    await invoke('modbench.plugin.enable');

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp'], true);
  });

  it('drops a locked row from the selection it writes', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter());
    await invoke('modbench.plugin.enable', alpha, [locked, alpha]);

    expect(setPluginsEnabled).toHaveBeenCalledWith(access, 'Default', ['Alpha.esp'], true);
  });

  it('calls nothing and reports nothing for an empty selection', async () => {
    const reporter = recordingReporter();

    registerPluginEnableCommands(access, instance, () => [], reporter);
    await invoke('modbench.plugin.enable');

    expect(setPluginsEnabled).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('says nothing when the whole selection lands', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });
    const reporter = recordingReporter();

    registerPluginEnableCommands(access, instance, () => [], reporter);
    await invoke('modbench.plugin.enable', alpha);

    expect(reporter.reports).toEqual([]);
  });

  it('reports a gone plugin by name through the shared selectionOutcome reporter, once, while the rest land', async () => {
    setPluginsEnabled.mockResolvedValue({
      applied: true,
      outcome: { landed: ['Alpha.esp'], refused: [{ item: 'Beta.esp', reason: 'Plugin not found in plugins.txt: Beta.esp' }] },
    });
    const reporter = recordingReporter();

    registerPluginEnableCommands(access, instance, () => [], reporter);
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

    registerPluginEnableCommands(access, instance, () => [], reporter);
    await invoke('modbench.plugin.disable', alpha);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to disable plugins.', detail: 'ENOENT' }]);
  });
});

describe('the enable and disable entries end when the read lands (common.md, A gesture that writes)', () => {
  const instance = {
    value: instanceValueFixture({ activeProfile: 'Default' }),
    refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
  };
  const alpha = new PluginNode({ name: 'Alpha.esp', enabled: false }, 'SomeMod');

  it('shows the progress bar from the key until the read after the write lands', async () => {
    setPluginsEnabled.mockImplementation(() => {
      progressSteps.push('write plugins.txt');
      return Promise.resolve({ applied: true, outcome: { landed: ['Alpha.esp'], refused: [] } });
    });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter());
    await invoke('modbench.plugin.enable', alpha);

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'write plugins.txt',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('still ends on the read when the whole write is refused', async () => {
    setPluginsEnabled.mockResolvedValue({ applied: false, refusal: 'ENOENT' });

    registerPluginEnableCommands(access, instance, () => [], recordingReporter());
    await invoke('modbench.plugin.enable', alpha);

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });
});
