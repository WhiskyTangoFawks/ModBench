import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MEditClient, PluginMetadata } from '../../client';
import type { PluginsDrop } from '../../pluginsCommands/plugins';
import { registerPluginMoveCommand } from '../pluginMoveCommand';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../PluginsTreeProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { adapterOver } from '../../test/mo2/adapterOver';
import { progressSteps } from '../../test/recordedProgress';

const MOVE = 'modbench.plugin.move';
const A = { name: 'A.esp', origin: 'ModA' };
const held = (name: string, masters: string[]): PluginMetadata => ({
  name, masters, path: `/data/${name}`, isLight: false, isMaster: false, isBlueprint: false, recordCount: 0, isImmutable: false,
  origin: 'SomeMod', inLoadOrder: true, hasMatchingRecords: false, isTracked: false, hasParseFailure: false, pluginSourceUnreadable: null,
});
const LOSING_END = { kind: 'losingEnd' } as const;
const noMasters = { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) };

const invoke = (...args: unknown[]) => Promise.resolve(present(handlers.get(MOVE), 'the move command')(...args));

let dir: string;
beforeEach(async () => {
  handlers.clear();
  progressSteps.length = 0;
  picks.label = undefined;
  dir = await mkdtemp(join(tmpdir(), 'plugin-move-'));
  await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
  await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'A.esp\r\nB.esp\r\nC.esp\r\n');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const plugins = () => readFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'utf8');

const PLACES: { label: string; drop: PluginsDrop }[] = [
  { label: 'C.esp', drop: { kind: 'before', name: 'C.esp' } },
  { label: 'Bottom of the view', drop: { kind: 'winningEnd' } },
];

function registered(
  selection: PluginsTreeNode[] = [], masters: Pick<MEditClient, 'getPlugins'> = noMasters,
  refresh = () => Promise.resolve(),
) {
  const reporter = recordingReporter();
  const instance = {
    value: instanceValueFixture({ activeProfile: 'Default' }),
    refresh: () => { progressSteps.push('Instance loader: read every file again'); return refresh(); },
  };
  registerPluginMoveCommand(adapterOver(dir), masters, instance, { selection: () => selection, movePlaces: () => PLACES }, reporter);
  return { reporter };
}

describe('modbench.plugin.move', () => {
  it('moves the plugins to the target and ends on the read after the write, under the Plugins view\'s progress', async () => {
    registered();

    await invoke([A], { kind: 'winningEnd' });

    expect(await plugins()).toBe('B.esp\r\nC.esp\r\nA.esp\r\n');
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('takes the focused view\'s selection when no plugin is named, leaving out a row that is not a plugin line', async () => {
    const { reporter } = registered([new PluginNode({ name: 'C.esp', enabled: true }, 'ModC'), new ImplicitMasterNode('Fallout4.esm', 'Data/')]);

    await invoke(undefined, LOSING_END);

    expect(reporter.reports).toEqual([]);
    expect(await plugins()).toBe('C.esp\r\nA.esp\r\nB.esp\r\n');
  });

  it('does nothing for no plugins', async () => {
    const { reporter } = registered();

    await invoke(undefined, LOSING_END);

    expect(progressSteps).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('with no target given, lands the block on the place picked', async () => {
    const { reporter } = registered();
    picks.label = 'C.esp';

    await invoke([A]);

    expect(reporter.reports).toEqual([]);
    expect(await plugins()).toBe('B.esp\r\nA.esp\r\nC.esp\r\n');
  });

  it('asks for the place when the target given is not one', async () => {
    registered();
    picks.label = 'Bottom of the view';

    await invoke([A], { kind: 'before' });

    expect(await plugins()).toBe('B.esp\r\nC.esp\r\nA.esp\r\n');
  });

  it('moves nothing and says nothing when the pick is dismissed', async () => {
    const { reporter } = registered();

    await invoke([A]);

    expect(await plugins()).toBe('A.esp\r\nB.esp\r\nC.esp\r\n');
    expect(reporter.reports).toEqual([]);
    expect(progressSteps).toEqual([]);
  });

  it('says why a move is refused by the plugin-order rules, naming both plugins', async () => {
        const { reporter } = registered([], { getPlugins: () => Promise.resolve([held('A.esp', []), held('B.esp', ['A.esp']), held('C.esp', [])]) });

    await invoke([A], { kind: 'winningEnd' });

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not move plugins.', detail: '"A.esp" is a master of "B.esp", so it must load before it.',
    }]);
  });

  it('says a target row gone from plugins.txt is gone', async () => {
    const { reporter } = registered();

    await invoke([A], { kind: 'before', name: 'Gone.esp' });

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not move plugins.', detail: 'Plugin not found in plugins.txt: Gone.esp' }]);
  });

  it('does not count the line of a plugin the game loads with no line', async () => {
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'DLCRobot.esm\r\nA.esp\r\nX.esp\r\n');
    const reporter = recordingReporter();
        const masters = { getPlugins: () => Promise.resolve([held('DLCRobot.esm', []), held('A.esp', []), held('X.esp', ['DLCRobot.esm'])]) };
    const value = instanceValueFixture({ activeProfile: 'Default', pluginsLoadedWithNoLine: [{ name: 'DLCRobot.esm', origin: 'Data/' }] });
    registerPluginMoveCommand(adapterOver(dir), masters, { value, refresh: () => Promise.resolve() }, { selection: () => [], movePlaces: () => [] }, reporter);

    await invoke([{ name: 'X.esp', origin: 'ModX' }], LOSING_END);

    expect(reporter.reports).toEqual([]);
    expect(await plugins()).toBe('X.esp\r\nDLCRobot.esm\r\nA.esp\r\n');
  });

  it('reports what throws as a failure, apart from a refusal', async () => {
    const { reporter } = registered([], noMasters, () => Promise.reject(new Error('read failed')));

    await invoke([A], LOSING_END);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to move plugins.', detail: 'read failed' }]);
  });
});
