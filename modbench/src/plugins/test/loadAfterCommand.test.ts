import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand, picks } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  const picks: { chosen: string[] | undefined; offered: string[]; options: unknown } = { chosen: undefined, offered: [], options: undefined };
  return {
    handlers,
    picks,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
  };
});

import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, Uri } from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand },
    window: {
      withProgress: recordedWithProgress,
      showQuickPick: (items: { label: string }[], options: unknown) => {
        picks.offered = items.map(({ label }) => label);
        picks.options = options;
        return Promise.resolve(picks.chosen && items.filter(({ label }) => picks.chosen?.includes(label)));
      },
    },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, Uri,
  };
});

import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { registerLoadAfterCommand } from '../loadAfterCommand';
import { PluginNode } from '../pluginRows';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { fakeInstanceAdapter, readingFixture, refusing } from '../../test/fakeInstanceAdapter';
import { progressSteps } from '../../test/recordedProgress';

const LOAD_AFTER = 'modbench.plugin.loadAfter';
const row = (name: string) => new PluginNode({ name, enabled: true }, 'ModA');
const invoke = (...args: unknown[]) => Promise.resolve(present(handlers.get(LOAD_AFTER), 'the load after command')(...args));
const wrote = (...additions: { plugin: string; after: string[] }[]) => [{ verb: 'changeUserlist', additions }];

function registered(offered: readonly string[] = ['C.esp', 'D.esp'], refusal?: string) {
  const reporter = recordingReporter();
  const fake = fakeInstanceAdapter(readingFixture(), { refusals: refusal === undefined ? undefined : refusing('changeUserlist', refusal) });
  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }), refresh: vi.fn(() => Promise.resolve()) };
  registerLoadAfterCommand({ changeUserlist: (rules) => fake.adapter.changeUserlist(rules), instance, reporter, places: () => offered }, () => []);
  return { reporter, fake, instance };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  picks.chosen = undefined;
  picks.offered = [];
});

describe('modbench.plugin.loadAfter', () => {
  it('picks many of the places offered outside the selection, and writes a rule for each selected plugin', async () => {
    const { fake, reporter, instance } = registered();
    picks.chosen = ['C.esp', 'D.esp'];

    await invoke(row('A.esp'), [row('A.esp'), row('B.esp')]);

    expect(picks.offered).toEqual(['C.esp', 'D.esp']);
    expect(picks.options).toMatchObject({ canPickMany: true });
    expect(fake.calls).toEqual(wrote({ plugin: 'A.esp', after: ['C.esp', 'D.esp'] }, { plugin: 'B.esp', after: ['C.esp', 'D.esp'] }));
    expect(reporter.reports).toEqual([]);
    expect(instance.refresh).toHaveBeenCalled();
  });

  it('writes nothing when the pick is dismissed', async () => {
    const { fake } = registered();

    await invoke(row('A.esp'));

    expect(fake.calls).toEqual([]);
  });

  it('writes nothing when nothing is picked', async () => {
    const { fake } = registered();
    picks.chosen = [];

    await invoke(row('A.esp'));

    expect(fake.calls).toEqual([]);
  });

  it('says why when the userlist cannot be written', async () => {
    const { reporter } = registered(['C.esp'], 'userlist.yaml is not a map');
    picks.chosen = ['C.esp'];

    await invoke(row('A.esp'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not write the load after.', detail: 'userlist.yaml is not a map' }]);
  });
});

describe('modbench.plugin.loadAfter, called by the agent', () => {
  const call = (plugins: string[], after: string[]) =>
    new AgentCall(plugins.map((name) => ({ kind: 'plugin' as const, plugin: { name, origin: 'ModA' } })), { after: after.map((name) => ({ name })) });

  it('names the plugins they load after, and answers the outcome', async () => {
    const { fake } = registered();

    const answered = await invoke(call(['A.esp'], ['C.esp']));

    expect(fake.calls).toEqual(wrote({ plugin: 'A.esp', after: ['C.esp'] }));
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'A.esp', origin: 'ModA' }], refused: [] } });
  });

  it('refuses a plugin that loads after itself, writing nothing', async () => {
    const { fake } = registered();

    await expect(invoke(call(['A.esp', 'B.esp'], ['B.esp']))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });

  it('refuses a call that names no plugin to load after, writing nothing', async () => {
    const { fake } = registered();

    await expect(invoke(call(['A.esp'], []))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});
