import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon } from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand },
    window: { withProgress: recordedWithProgress },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
  };
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MEditClient, PluginMetadata } from '../../client';
import { registerPluginMoveCommand } from '../pluginMoveCommand';
import { ImplicitMasterNode, PluginNode } from '../PluginsTreeProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { accessTo } from '../../test/mo2/adapterOver';
import { progressSteps } from '../../test/recordedProgress';

const MOVE = 'modbench.plugin.move';
const A = { name: 'A.esp', origin: 'ModA' };
const LOSING_END = { kind: 'losingEnd' } as const;
const noMasters = { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) };

const invoke = (...args: unknown[]) => Promise.resolve(present(handlers.get(MOVE), 'the move command')(...args));

let dir: string;
beforeEach(async () => {
  handlers.clear();
  progressSteps.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'plugin-move-'));
  await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
  await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'A.esp\r\nB.esp\r\nC.esp\r\n');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const plugins = () => readFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'utf8');

function registered(
  selection: PluginNode[] = [], masters: Pick<MEditClient, 'getPlugins'> = noMasters,
  refresh = () => Promise.resolve(),
) {
  const reporter = recordingReporter();
  const instance = {
    value: instanceValueFixture({ activeProfile: 'Default' }),
    refresh: () => { progressSteps.push('Instance loader: read every file again'); return refresh(); },
  };
  registerPluginMoveCommand(accessTo(dir), masters, instance, () => selection, reporter);
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
    const { reporter } = registered([new PluginNode({ name: 'C.esp', enabled: true }, 'ModC'), new ImplicitMasterNode('Fallout4.esm', 'Data')]);

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

  it('refuses a call with no target, saying the target is missing', async () => {
    const { reporter } = registered();

    await invoke([A]);
    await invoke([A], { kind: 'before' });

    expect(reporter.reports).toEqual(Array(2).fill({ severity: 'error', message: 'Could not move plugins.', detail: 'No target to move them to.' }));
    expect(progressSteps).toEqual([]);
  });

  it('says why a move is refused by the plugin-order rules, naming both plugins', async () => {
    const held = (name: string, masters: string[]) => ({ name, masters, isBlueprint: false, inLoadOrder: true }) as PluginMetadata;
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
    const held = (name: string, masters: string[]) => ({ name, masters, isBlueprint: false, inLoadOrder: true }) as PluginMetadata;
    const masters = { getPlugins: () => Promise.resolve([held('DLCRobot.esm', []), held('A.esp', []), held('X.esp', ['DLCRobot.esm'])]) };
    const value = instanceValueFixture({ activeProfile: 'Default', pluginsLoadedWithNoLine: [{ name: 'DLCRobot.esm', origin: 'Data' }] });
    registerPluginMoveCommand(accessTo(dir), masters, { value, refresh: () => Promise.resolve() }, () => [], reporter);

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
