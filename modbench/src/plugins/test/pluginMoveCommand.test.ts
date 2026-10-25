import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand, picks } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    picks: { label: undefined as string | undefined },
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
    window: {
      withProgress: recordedWithProgress,
      showQuickPick: (items: { label: string }[]) => Promise.resolve(items.find(({ label }) => label === picks.label)),
    },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, Uri: { from: uriFrom },
  };
});

import type { MEditClient, PluginMetadata } from '../../client';
import type { PluginsDrop } from '../../pluginCommands/plugins';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { registerPluginMoveCommand } from '../pluginMoveCommand';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../pluginRows';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { progressSteps } from '../../test/recordedProgress';

const MOVE = 'modbench.plugin.move';
const A = { name: 'A.esp', origin: 'ModA' };
const held = (name: string, masters: string[]): PluginMetadata => ({
  name, masters, path: `/data/${name}`, isLight: false, isMaster: false, isBlueprint: false, isImmutable: false,
  origin: 'SomeMod', inLoadOrder: true, hasMatchingRecords: false, isCompiledPlugin: false, hasParseFailure: false, pluginSourceUnreadable: null,
});
const LOSING_END = { kind: 'losingEnd' } as const;
const noMasters = { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) };

const rowsOf = (...addresses: { name: string; origin: string }[]): [PluginNode | undefined, PluginNode[]] => {
  const rows = addresses.map(({ name, origin }) => new PluginNode({ name, enabled: true }, origin));
  return [rows[0], rows];
};
const invoke = (...args: unknown[]) => Promise.resolve(present(handlers.get(MOVE), 'the move command')(...args));

const fakeOver = (...names: string[]) => fakeInstanceAdapter(readingFixture({ pluginOrder: names.map((name) => ({ name, enabled: true })) }));
const moved = (plugin: string, toIndex: number) => [{ verb: 'changePluginOrderOverProvided', profile: 'Default', changes: [{ kind: 'move', plugins: [plugin], toIndex }] }];

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  picks.label = undefined;
});

const PLACES: { label: string; drop: PluginsDrop }[] = [
  { label: 'C.esp', drop: { kind: 'before', name: 'C.esp' } },
  { label: 'Bottom of the view', drop: { kind: 'winningEnd' } },
];

function registered(
  selection: PluginsTreeNode[] = [], masters: Pick<MEditClient, 'getPlugins'> = noMasters,
  refresh = () => Promise.resolve(), fake = fakeOver('A.esp', 'B.esp', 'C.esp'),
  value = instanceValueFixture({ activeProfile: 'Default' }),
) {
  const reporter = recordingReporter();
  const instance = {
    value,
    refresh: () => { progressSteps.push('Instance loader: read every file again'); return refresh(); },
  };
  registerPluginMoveCommand(pluginCommandsWith(fake.adapter, masters), instance, { selection: () => selection, movePlaces: () => PLACES }, reporter);
  return { reporter, fake };
}

describe('modbench.plugin.move', () => {
  it('hands the adapter the move to the target and ends on the read after it, under the Plugins view\'s progress', async () => {
    const { fake } = registered();

    await invoke(...rowsOf(A), { kind: 'winningEnd' });

    expect(fake.calls).toEqual(moved('A.esp', 2));
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('takes the focused view\'s selection when no plugin is named, leaving out a row that is not a plugin line', async () => {
    const { reporter, fake } = registered([new PluginNode({ name: 'C.esp', enabled: true }, 'ModC'), new ImplicitMasterNode('Fallout4.esm', 'Data/')]);

    await invoke(undefined, undefined, LOSING_END);

    expect(reporter.reports).toEqual([]);
    expect(fake.calls).toEqual(moved('C.esp', 0));
  });

  it('with no target given, lands the block on the place picked', async () => {
    const { reporter, fake } = registered();
    picks.label = 'C.esp';

    await invoke(...rowsOf(A));

    expect(reporter.reports).toEqual([]);
    expect(fake.calls).toEqual(moved('A.esp', 1));
  });

  it('asks for the place when the target given is not one', async () => {
    const { fake } = registered();
    picks.label = 'Bottom of the view';

    await invoke(...rowsOf(A), { kind: 'before' });

    expect(fake.calls).toEqual(moved('A.esp', 2));
  });

  it('moves nothing and says nothing when the pick is dismissed', async () => {
    const { reporter, fake } = registered();

    await invoke(...rowsOf(A));

    expect(fake.calls).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(progressSteps).toEqual([]);
  });

  it('says why a move is refused by the plugin-order rules, naming both plugins', async () => {
    const { reporter, fake } = registered([], { getPlugins: () => Promise.resolve([held('A.esp', []), held('B.esp', ['A.esp']), held('C.esp', [])]) });

    await invoke(...rowsOf(A), { kind: 'winningEnd' });

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not move plugins.', detail: '"A.esp" is a master of "B.esp", so it must load before it.',
    }]);
    expect(fake.calls).toEqual([]);
  });

  it('reports what throws as a failure, apart from a refusal', async () => {
    const { reporter } = registered([], noMasters, () => Promise.reject(new Error('read failed')));

    await invoke(...rowsOf(A), LOSING_END);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to move plugins.', detail: 'read failed' }]);
  });
});

describe('modbench.plugin.move, called by the agent', () => {
  const given = (...plugins: { name: string; origin: string }[]) => new AgentCall(plugins.map((plugin) => ({ kind: 'plugin' as const, plugin })), { drop: LOSING_END });

  it('moves the plugins given to the drop given, never the selection, picking and reporting nothing, and answers the outcome', async () => {
    const { reporter, fake } = registered([new PluginNode({ name: 'C.esp', enabled: true }, 'ModC')]);

    const answered = await invoke(given(A));

    expect(fake.calls).toEqual(moved('A.esp', 0));
    expect(answered).toEqual({ applied: true, outcome: { landed: [A], refused: [] } });
    expect(reporter.reports).toEqual([]);
  });

  it('answers a refusal by the plugin-order rules, reporting nothing', async () => {
    const { reporter, fake } = registered([], { getPlugins: () => Promise.resolve([held('A.esp', []), held('B.esp', ['A.esp']), held('C.esp', [])]) });

    const answered = await invoke(new AgentCall([{ kind: 'plugin', plugin: A }], { drop: { kind: 'winningEnd' } }));

    expect(answered).toEqual({ applied: false, refusal: 'Could not move plugins.', detail: '"A.esp" is a master of "B.esp", so it must load before it.' });
    expect(fake.calls).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('refuses an Argument that is not a plugin, writing nothing', async () => {
    const { fake } = registered();

    await expect(invoke(new AgentCall([{ kind: 'mod', name: 'ModA' }], { drop: LOSING_END }))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});
