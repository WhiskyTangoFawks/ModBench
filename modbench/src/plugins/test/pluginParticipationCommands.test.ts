import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
  };
});

import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand },
    window: { withProgress: recordedWithProgress },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, Uri: { from: uriFrom },
  };
});

import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { registerPluginEnableCommands } from '../pluginParticipationCommands';
import { PluginNode, ImplicitMasterNode } from '../pluginRows';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, refusing, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { progressSteps } from '../../test/recordedProgress';

const REFUSED: InstanceAnswers = { refusals: refusing('changePluginOrder', 'ENOENT: no plugins.txt') };
const fake = (answers: InstanceAnswers = {}) =>
  fakeInstanceAdapter(readingFixture({ pluginOrder: [{ name: 'Alpha.esp', enabled: false }, { name: 'Beta.esp', enabled: true }] }), answers);
const enabling = (...pairs: [string, boolean][]) =>
  [{ verb: 'changePluginOrder', profile: 'Default', changes: pairs.map(([plugin, enabled]) => ({ kind: 'enable', plugin, enabled })) }];

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const handler = present(handlers.get(commandId), `command not registered: ${commandId}`);
  return Promise.resolve(handler(...args));
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
});

const instance = () => ({
  value: instanceValueFixture({ activeProfile: 'Default' }),
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
});

function registered(adapter = fake(), viewSelection: () => PluginNode[] = () => []) {
  const reporter = recordingReporter();
  registerPluginEnableCommands(pluginCommandsWith(adapter.adapter), instance(), viewSelection, reporter);
  return { reporter, adapter };
}

describe('modbench.plugin.enable / modbench.plugin.disable: the whole selection, one command per direction', () => {
  const alpha = new PluginNode({ name: 'Alpha.esp', enabled: false }, 'SomeMod');
  const beta = new PluginNode({ name: 'Beta.esp', enabled: true }, 'SomeMod');
  const locked = new ImplicitMasterNode('Fallout4.esm', 'Data/');

  it.each([['modbench.plugin.enable', true], ['modbench.plugin.disable', false]] as const)(
    '%s applies to every selected plugin, whatever its own current state', async (command, enabled) => {
      const { adapter } = registered();
      await invoke(command, alpha, [alpha, beta]);

      expect(adapter.calls).toEqual(enabling(['Alpha.esp', enabled], ['Beta.esp', enabled]));
    });

  it('drops a locked row from the selection it writes', async () => {
    const { reporter, adapter } = registered();
    await invoke('modbench.plugin.enable', alpha, [locked, alpha]);

    expect(adapter.calls).toEqual(enabling(['Alpha.esp', true]));
    expect(reporter.reports).toEqual([]);
  });

  it('says nothing when the whole selection lands', async () => {
    const { reporter } = registered();
    await invoke('modbench.plugin.enable', alpha);

    expect(reporter.reports).toEqual([]);
  });

  it('reports a gone plugin by name, once, while the rest land', async () => {
    const { reporter, adapter } = registered();
    await invoke('modbench.plugin.enable', alpha, [alpha, new PluginNode({ name: 'Gone.esp', enabled: true }, 'SomeMod')]);

    expect(adapter.calls).toEqual(enabling(['Alpha.esp', true]));
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"Gone.esp" (Plugin not found in plugins.txt: Gone.esp)' },
    ]);
  });

  it('reports the whole selection refused, once, when the adapter refuses the change', async () => {
    const { reporter } = registered(fake(REFUSED));

    await invoke('modbench.plugin.disable', alpha);

    expect(reporter.reports).toMatchObject([{ severity: 'error', message: 'Failed to disable plugins.' }]);
  });
});

describe('the enable and disable entries end when the read lands (common.md, A gesture that writes)', () => {
  const alpha = new PluginNode({ name: 'Alpha.esp', enabled: false }, 'SomeMod');
  const ENDS_ON_THE_READ = [
    'progress opens on modbench.pluginListTree',
    'Instance loader: read every file again',
    'progress closes',
  ];

  it('shows the progress bar from the key until the read after the write lands', async () => {
    registered();
    await invoke('modbench.plugin.enable', alpha);

    expect(progressSteps).toEqual(ENDS_ON_THE_READ);
  });
});

describe('modbench.plugin.enable / modbench.plugin.disable, called by the agent', () => {
  const selected = new PluginNode({ name: 'Alpha.esp', enabled: false }, 'SomeMod');
  const given = (...names: string[]) => new AgentCall(names.map((name) => ({ kind: 'plugin' as const, plugin: { name, origin: 'SomeMod' } })), {});

  it.each([['modbench.plugin.enable', true], ['modbench.plugin.disable', false]])(
    '%s acts on the plugins given, never on the selection, and answers the outcome by address, reporting nothing', async (command, enabled) => {
      const { reporter, adapter } = registered(fake(), () => [selected]);

      const answered = await invoke(command, given('Beta.esp', 'Gone.esp'));

      expect(adapter.calls).toEqual(enabling(['Beta.esp', enabled]));
      expect(answered).toEqual({
        applied: true,
        outcome: {
          landed: [{ name: 'Beta.esp', origin: 'SomeMod' }],
          refused: [{ item: { name: 'Gone.esp', origin: 'SomeMod' }, reason: 'Plugin not found in plugins.txt: Gone.esp' }],
        },
      });
      expect(reporter.reports).toEqual([]);
    });

  it('refuses an Argument that is not a plugin, writing nothing', async () => {
    const { adapter } = registered();

    await expect(invoke('modbench.plugin.enable', new AgentCall([{ kind: 'mod', name: 'SomeMod' }], {}))).rejects.toBeInstanceOf(Refusal);

    expect(adapter.calls).toEqual([]);
  });
});
