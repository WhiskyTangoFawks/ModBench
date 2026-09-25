import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFilePlain, uriFrom, DataTransferItem, DataTransfer,
} from './vscodeMock';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { FakeInstance } from './mo2/fakeInstance';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';
import {
  filterBoxWindowMock, filterBoxCommandsMock, commandInvoker, currentBoxOf, waitForMessage,
} from './nameFilterViewHarness';
import type { InstanceValue } from '../instanceLoader/instance';
import type { LoadOrderPlugin, LoadOrderPluginLine } from '../instanceLoader/loadOrderSnapshot';

// `vi.mock`'s factory runs before this file's own top-level code (`../toolbox` reaches `vscode`
// first), so the state it closes over is built from literals here and handed to the harness.
const h = vi.hoisted(() => ({
  state: { commands: new Map<string, (...args: unknown[]) => unknown>(), boxes: [] },
}));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFilePlain, from: uriFrom }, DataTransferItem, DataTransfer,
  window: filterBoxWindowMock(h.state),
  commands: filterBoxCommandsMock(h.state),
}));

import { registerPluginsNameFilter } from '../toolbox';
import { say } from '../editingTeardown';
import { PluginsTreeProvider, type PluginListSource } from '../plugins/PluginsTreeProvider';
import { syncMessageDouble } from './syncMessageDouble';

class FakeSource implements PluginListSource {
  reorderPlugins(): Promise<void> { return Promise.resolve(); }
}

function plugin(name: string): LoadOrderPlugin | LoadOrderPluginLine {
  return { name, path: `/fixture/${name}`, origin: 'SomeMod', slot: 0, enabled: true, winning: true };
}

const FOUND = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;

const valueOf = (plugins: (LoadOrderPlugin | LoadOrderPluginLine)[]): InstanceValue =>
  instanceValueFixture({ plugins, gameFolder: FOUND });

const notFoundValueOf = (plugins: (LoadOrderPlugin | LoadOrderPluginLine)[]): InstanceValue =>
  instanceValueFixture({ plugins, gameFolder: GAME_FOLDER_NOT_FOUND });

const GAME_FOLDER_MESSAGE =
  "Game folder not found: set modbench.mods.gameDirectory. The Toolbox's Game row names each place Modbench looked.";

const command = commandInvoker(h.state);
const currentBox = currentBoxOf(h.state);

// `setImmediate` runs after the whole microtask queue drains, however many `await`s a real
// `PluginsTreeProvider` recompute chains — an order the event loop guarantees, not a duration.
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  h.state.commands.clear();
  h.state.boxes.length = 0;
});

describe('the Plugins filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a reconcile, in both directions', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    await provider.getChildren();

    const view: { description?: string; message?: string } = {};
    registerPluginsNameFilter(view, provider, syncMessageDouble());

    await command('modbench.plugin.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(view.message).toBe('No matches for "zzznomatch".');

    instance.publish(valueOf([plugin('TestMod.esp'), plugin('zzznomatch.esp')]));
    await waitForMessage(view, (m) => m === undefined, 'the message clearing once a matching plugin lands');
    expect(view.message).toBeUndefined();

    instance.publish(valueOf([plugin('TestMod.esp')]));
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the plugin is gone');
    expect(view.message).toBe('No matches for "zzznomatch".');
  });
});

describe('a running say() statement survives a background row change', () => {
  it('is left standing when a reconcile tick still matches nothing', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    await provider.getChildren();

    const view: { description?: string; message?: string } = {};
    const filter = registerPluginsNameFilter(view, provider, syncMessageDouble());

    await command('modbench.plugin.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');

    say({ pluginsTreeView: view, pluginsNameFilter: filter }, 'Starting backend…');
    provider.applyIndexed(['TestMod.esp'], []);
    await flush();
    expect(view.message).toBe('Starting backend…');
  });

  it('is left standing when a fresh Instance value would otherwise have cleared it', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    await provider.getChildren();

    const view: { description?: string; message?: string } = {};
    const filter = registerPluginsNameFilter(view, provider, syncMessageDouble());

    await command('modbench.plugin.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');

    say({ pluginsTreeView: view, pluginsNameFilter: filter }, 'Starting backend…');
    instance.publish(valueOf([plugin('TestMod.esp'), plugin('zzznomatch.esp')]));
    await flush();
    expect(view.message).toBe('Starting backend…');
  });
});

describe('the Plugins view, given the game folder not found', () => {
  async function pluginsView(instance: FakeInstance) {
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    await provider.getChildren();
    const view: { description?: string; message?: string } = {};
    const filter = registerPluginsNameFilter(view, provider, syncMessageDouble());
    return { provider, view, filter };
  }

  it('says so in its message line, and keeps its rows', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const { provider, view } = await pluginsView(instance);

    instance.publish(notFoundValueOf([plugin('TestMod.esp')]));

    await waitForMessage(view, (m) => m === GAME_FOLDER_MESSAGE, 'the game folder message');
    expect(view.message).toBe(GAME_FOLDER_MESSAGE);
    expect(await provider.getChildren()).toHaveLength(1);
  });

  it('clears the message on the next value with the game folder found', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const { view } = await pluginsView(instance);
    instance.publish(notFoundValueOf([plugin('TestMod.esp')]));
    await waitForMessage(view, (m) => m === GAME_FOLDER_MESSAGE, 'the game folder message');

    instance.publish(valueOf([plugin('TestMod.esp')]));

    await waitForMessage(view, (m) => m === undefined, 'the message clearing');
    expect(view.message).toBeUndefined();
  });

  // Rival: reading the empty value before the first read as a game folder not found.
  it('says nothing before the first read lands', async () => {
    const instance = new FakeInstance(notFoundValueOf([]), 0);
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    const view: { description?: string; message?: string } = {};
    const filter = registerPluginsNameFilter(view, provider, syncMessageDouble());

    filter.refresh();
    await flush();

    expect(view.message).toBeUndefined();
  });

  it('gives the line to the filter\'s no-match message, and takes it back once the filter clears', async () => {
    const instance = new FakeInstance(notFoundValueOf([plugin('TestMod.esp')]));
    const { view } = await pluginsView(instance);

    await command('modbench.plugin.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the no-match message');

    await command('modbench.plugin.clearFilter')();
    await waitForMessage(view, (m) => m === GAME_FOLDER_MESSAGE, 'the game folder message returning');
    expect(view.message).toBe(GAME_FOLDER_MESSAGE);
  });

  it('leaves the start-up message its line, and takes it back once that clears', async () => {
    const instance = new FakeInstance(notFoundValueOf([plugin('TestMod.esp')]));
    const { view, filter } = await pluginsView(instance);
    const session = { pluginsTreeView: view, pluginsNameFilter: filter };

    say(session, 'Starting backend…');
    instance.publish(notFoundValueOf([plugin('TestMod.esp')]));
    await flush();
    expect(view.message).toBe('Starting backend…');

    say(session, undefined);
    await waitForMessage(view, (m) => m === GAME_FOLDER_MESSAGE, 'the game folder message returning');
    expect(view.message).toBe(GAME_FOLDER_MESSAGE);
  });
});

describe('the Plugins view, given a plugin sync that refused', () => {
  const SYNC_MESSAGE = 'plugins.txt is not synced: the game folder is not found.';

  async function refusedView(value: InstanceValue) {
    const instance = new FakeInstance(value);
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    await provider.getChildren();
    const view: { description?: string; message?: string } = {};
    const pluginSync = syncMessageDouble();
    registerPluginsNameFilter(view, provider, pluginSync);
    return { view, pluginSync };
  }

  // Rival: the sync's line replacing the view's own, or never reaching the line at all.
  it('says it beside the game folder message, and drops only its own once the sync lands', async () => {
    const { view, pluginSync } = await refusedView(notFoundValueOf([plugin('TestMod.esp')]));

    pluginSync.say(SYNC_MESSAGE);
    await waitForMessage(view, (m) => m === `${GAME_FOLDER_MESSAGE} ${SYNC_MESSAGE}`, 'both messages');

    pluginSync.say(undefined);
    await waitForMessage(view, (m) => m === GAME_FOLDER_MESSAGE, 'the game folder message alone');
    expect(view.message).toBe(GAME_FOLDER_MESSAGE);
  });

  it('gives the line to the filter\'s no-match message, and takes it back once the filter clears', async () => {
    const { view, pluginSync } = await refusedView(valueOf([plugin('TestMod.esp')]));
    pluginSync.say(SYNC_MESSAGE);
    await waitForMessage(view, (m) => m === SYNC_MESSAGE, 'the sync message');

    await command('modbench.plugin.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the no-match message');

    await command('modbench.plugin.clearFilter')();
    await waitForMessage(view, (m) => m === SYNC_MESSAGE, 'the sync message returning');
    expect(view.message).toBe(SYNC_MESSAGE);
  });
});
