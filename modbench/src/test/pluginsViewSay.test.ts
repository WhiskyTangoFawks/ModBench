import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, uriFrom, DataTransferItem, DataTransfer,
} from './vscodeMock';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { FakeInstance } from './mo2/fakeInstance';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';
import {
  filterBoxWindowMock, filterBoxCommandsMock, currentBoxOf, waitForMessage,
} from '../drivingLib/test/nameFilterViewHarness';
import type { InstanceValue } from '../instanceLoader/instance';
import type { LoadOrderPlugin, LoadOrderPluginLine } from '../instanceLoader/loadOrderSnapshot';

const h = vi.hoisted(() => ({
  state: { commands: new Map<string, (...args: unknown[]) => unknown>(), boxes: [] },
}));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile, from: uriFrom }, DataTransferItem, DataTransfer,
  window: filterBoxWindowMock(h.state),
  commands: filterBoxCommandsMock(h.state),
}));

import { registerPluginsNameFilter } from '../plugins/pluginsView';
import { say } from '../editingTeardown';
import { NO_PLUGINS_MESSAGE, PluginsTreeProvider, type PluginListSource } from '../plugins/PluginsTreeProvider';
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

const currentBox = currentBoxOf(h.state);

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  h.state.commands.clear();
  h.state.boxes.length = 0;
});

describe('a running say() statement survives a background row change', () => {
  it('is left standing when a reconcile tick still matches nothing', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    await provider.getChildren();

    const view: { description?: string; message?: string } = {};
    const filter = registerPluginsNameFilter(view, provider, syncMessageDouble());

    filter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');

    say({ plugins: { tree: provider, view, nameFilter: filter } }, 'Starting backend…');
    provider.applyIndexed([{ name: 'TestMod.esp', origin: 'SomeMod' }], []);
    await flush();
    expect(view.message).toBe('Starting backend…');
  });

  it('is left standing when a fresh Instance value would otherwise have cleared it', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    await provider.getChildren();

    const view: { description?: string; message?: string } = {};
    const filter = registerPluginsNameFilter(view, provider, syncMessageDouble());

    filter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');

    say({ plugins: { tree: provider, view, nameFilter: filter } }, 'Starting backend…');
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

  it('leaves the start-up message its line, and takes it back once that clears', async () => {
    const instance = new FakeInstance(notFoundValueOf([plugin('TestMod.esp')]));
    const { provider, view, filter } = await pluginsView(instance);
    const session = { plugins: { tree: provider, view, nameFilter: filter } };

    say(session, 'Starting backend…');
    instance.publish(notFoundValueOf([plugin('TestMod.esp')]));
    await flush();
    expect(view.message).toBe('Starting backend…');

    say(session, undefined);
    await waitForMessage(view, (m) => m === GAME_FOLDER_MESSAGE, 'the game folder message returning');
    expect(view.message).toBe(GAME_FOLDER_MESSAGE);
  });
});

describe('the Plugins view, given no lines and no locked plugins', () => {
  async function emptyView(instance: FakeInstance) {
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    const view: { description?: string; message?: string } = {};
    const filter = registerPluginsNameFilter(view, provider, syncMessageDouble());
    const rows = await provider.getChildren();
    return { provider, view, filter, rows };
  }

  it('leaves the start-up message its line, and takes the line back once that clears', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const { provider, view, filter } = await emptyView(instance);
    const session = { plugins: { tree: provider, view, nameFilter: filter } };

    say(session, 'Starting backend…');
    instance.publish(valueOf([]));
    await provider.getChildren();
    await flush();
    expect(view.message).toBe('Starting backend…');

    say(session, undefined);
    await waitForMessage(view, (m) => m === NO_PLUGINS_MESSAGE, 'the empty-list message returning');
    expect(view.message).toBe(NO_PLUGINS_MESSAGE);
  });
});
