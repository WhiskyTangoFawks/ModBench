import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, uriFrom, DataTransferItem, DataTransfer,
} from '../../test/vscodeMock';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import {
  filterBoxWindowMock, filterBoxCommandsMock, currentBoxOf, waitForMessage,
} from '../../drivingLib/test/nameFilterViewHarness';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { LoadOrderPlugin, LoadOrderPluginLine } from '../../instanceLoader/loadOrderSnapshot';

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

import { registerPluginsNameFilter } from '../pluginsView';
import { NO_PLUGINS_MESSAGE, PluginsTreeProvider, type PluginListSource } from '../PluginsTreeProvider';
import { InMemoryMEditClient, type PluginMetadata } from '../../client';
import { syncMessageDouble } from '../../test/syncMessageDouble';

function say(
  session: { pluginsTreeView: { message?: string }; pluginsNameFilter: { refresh(): void } }, message: string | undefined,
): void {
  session.pluginsTreeView.message = message;
  if (message === undefined) session.pluginsNameFilter.refresh();
}

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

describe('the Plugins filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a reconcile, in both directions', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    await provider.getChildren();

    const view: { description?: string; message?: string } = {};
    const filter = registerPluginsNameFilter(view, provider, syncMessageDouble());

    filter.open();
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

    filter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');

    say({ pluginsTreeView: view, pluginsNameFilter: filter }, 'Starting backend…');
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
    const { view, filter } = await pluginsView(instance);

    filter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the no-match message');

    filter.clear();
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

describe('the Plugins view, given no lines and no locked plugins', () => {
  async function emptyView(instance: FakeInstance) {
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    const view: { description?: string; message?: string } = {};
    const filter = registerPluginsNameFilter(view, provider, syncMessageDouble());
    const rows = await provider.getChildren();
    return { provider, view, filter, rows };
  }

  it('says so in its message line, and shows no row', async () => {
    const { view, rows } = await emptyView(new FakeInstance(valueOf([])));

    await waitForMessage(view, (m) => m === NO_PLUGINS_MESSAGE, 'the empty-list message');
    expect(rows).toEqual([]);
  });

  it('clears the message once a line lands', async () => {
    const instance = new FakeInstance(valueOf([]));
    const { provider, view } = await emptyView(instance);
    await waitForMessage(view, (m) => m === NO_PLUGINS_MESSAGE, 'the empty-list message');

    instance.publish(valueOf([plugin('TestMod.esp')]));
    await provider.getChildren();

    await waitForMessage(view, (m) => m === undefined, 'the message clearing');
    expect(view.message).toBeUndefined();
  });

  it('leaves the start-up message its line, and takes the line back once that clears', async () => {
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const { provider, view, filter } = await emptyView(instance);
    const session = { pluginsTreeView: view, pluginsNameFilter: filter };

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

function held(name: string, hasMatchingRecords: boolean): PluginMetadata {
  return {
    name, path: `/fixture/${name}`, loadOrderIndex: 0, isLight: false, isMaster: false, isBlueprint: false, masters: [], recordCount: 0,
    isImmutable: false, origin: 'SomeMod', masterIssues: [], inLoadOrder: true, hasMatchingRecords, isTracked: false,
    hasParseFailure: false,
  };
}

describe('the Plugins view, given a record filter that matches nothing', () => {
  async function filteredView(testModMatches: boolean, source: string | null = 'armor.sql') {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [held('Other.esp', false), held('TestMod.esp', testModMatches)]);
    client.setQueryAnswer('getDiagnoses', []);
    const instance = new FakeInstance(valueOf([plugin('Other.esp'), plugin('TestMod.esp')]));
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource(), client });
    const view: { description?: string; message?: string } = {};
    const pluginSync = syncMessageDouble();
    const filter = registerPluginsNameFilter(view, provider, pluginSync);
    provider.setRecordFilterSource(source ?? undefined);
    await provider.refreshFacts();
    return { client, provider, view, pluginSync, filter };
  }

  const LAST_SYNC_MESSAGE = 'sentinel.';
  async function lineOnceRendersHaveLanded(view: { message?: string }, pluginSync: ReturnType<typeof syncMessageDouble>) {
    pluginSync.say(LAST_SYNC_MESSAGE);
    await waitForMessage(view, (m) => m?.endsWith(LAST_SYNC_MESSAGE) === true, 'the sync message reaching the line');
    return view.message;
  }

  it('says so in its message line, naming the source', async () => {
    const { view } = await filteredView(false);

    await waitForMessage(view, (m) => m === 'No records match armor.sql.', 'the no-match message');
    expect(view.message).toBe('No records match armor.sql.');
  });

  it('says nothing while the filter matches a record in any plugin', async () => {
    const { view, pluginSync } = await filteredView(true);

    expect(await lineOnceRendersHaveLanded(view, pluginSync)).toBe(LAST_SYNC_MESSAGE);
  });

  it('says nothing while no record filter is in force, whatever the facts say', async () => {
    const { view, pluginSync } = await filteredView(false, null);

    expect(await lineOnceRendersHaveLanded(view, pluginSync)).toBe(LAST_SYNC_MESSAGE);
  });

  it('takes the message back once the filter clears', async () => {
    const { client, provider, view } = await filteredView(false);
    await waitForMessage(view, (m) => m === 'No records match armor.sql.', 'the no-match message');

    provider.setRecordFilterSource(undefined);
    client.setQueryAnswer('getPlugins', [held('Other.esp', true), held('TestMod.esp', true)]);
    await provider.refreshFacts();

    await waitForMessage(view, (m) => m === undefined, 'the message clearing');
    expect(view.message).toBeUndefined();
  });
});

describe('the Plugins view, given a plugin sync that refused', () => {
  const SYNC_MESSAGE = "plugins.txt is not synced: the game's Data folder cannot be listed: EACCES.";
  const NO_RECORD_MATCH = 'No records match armor.sql.';

  async function refusedView(recordFilter?: string) {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [held('TestMod.esp', false)]);
    client.setQueryAnswer('getDiagnoses', []);
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource(), client });
    await provider.getChildren();
    const view: { description?: string; message?: string } = {};
    const pluginSync = syncMessageDouble();
    const filter = registerPluginsNameFilter(view, provider, pluginSync);
    provider.setRecordFilterSource(recordFilter);
    await provider.refreshFacts();
    return { view, pluginSync, filter };
  }

  it('says it beside the view\'s own message, and drops only its own once the sync lands', async () => {
    const { view, pluginSync } = await refusedView('armor.sql');

    pluginSync.say(SYNC_MESSAGE);
    await waitForMessage(view, (m) => m === `${NO_RECORD_MATCH} ${SYNC_MESSAGE}`, 'both messages');

    pluginSync.say(undefined);
    await waitForMessage(view, (m) => m === NO_RECORD_MATCH, 'the view\'s own message alone');
    expect(view.message).toBe(NO_RECORD_MATCH);
  });

  it('gives the line to the filter\'s no-match message, and takes it back once the filter clears', async () => {
    const { view, pluginSync, filter } = await refusedView();
    pluginSync.say(SYNC_MESSAGE);
    await waitForMessage(view, (m) => m === SYNC_MESSAGE, 'the sync message');

    filter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the no-match message');

    filter.clear();
    await waitForMessage(view, (m) => m === SYNC_MESSAGE, 'the sync message returning');
    expect(view.message).toBe(SYNC_MESSAGE);
  });
});
