import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { DiagnosticSeverity, host, Uri } from './vscodeHost';
import { clientHoldingNothing, indexedOver, pluginsOf, pluginsOver } from './pluginsOver';
import { createFocusedView } from '../../drivingLib/focusedView';
import { pluginArgumentOf } from '../../drivingLib/argument';
import { waitForMessage } from '../../drivingLib/test/nameFilterViewHarness';
import type { PluginMetadata, RecordSummary } from '../../client';
import { pluginMetadataFixture, recordTypeCountFixture } from '../../client/test/fixtures';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { PluginSyncRun } from '../../pluginCommands/plugins';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { holdsLoadOrder, changeNamesPlugin } from '../../client/test/says';
import { settled } from '../../test/eventually';

const FOUND = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
const ARMOR_SQL = 'SELECT form_key FROM "armo"';
const UNTITLED = Uri.parse('untitled:Untitled-1');

const TEST_PLUGIN = { name: 'Test.esp', origin: 'ModA' };
const rowsChanged = (keys: string[] = []) => [{ plugin: TEST_PLUGIN, keys }];

const settle = () => new Promise((resolve) => setImmediate(resolve));
const pluginReads = (client: InMemoryMEditClient) => client.calls.filter((call) => call.method === 'getPlugins').length;
const found = (...names: string[]): InstanceValue => instanceValueFixture({ plugins: pluginsOf(names, 'SomeMod'), gameFolder: FOUND });
const notFound = (...names: string[]): InstanceValue => instanceValueFixture({ plugins: pluginsOf(names, 'SomeMod'), gameFolder: GAME_FOLDER_NOT_FOUND });
const documentAt = (name: string, sql = ARMOR_SQL) => { host.files.set(name, sql); return Uri.file(`/workspace/${name}`); };
const picked = () => host.quickPicks.map(({ items }) => items);

async function handedOff(client: InMemoryMEditClient): Promise<void> {
  const before = pluginReads(client);
  holdsLoadOrder(client, { total: 3 });
  await settled(() => { expect(pluginReads(client)).toBeGreaterThan(before); });
  await settle();
  client.calls.length = 0;
}

function syncRefusing() {
  let refusal: string | undefined;
  const syncPlugins: PluginSyncRun = () => Promise.resolve(refusal === undefined
    ? { applied: true, wrote: false, added: [], dropped: [] }
    : { applied: false, refusal });
  return {
    syncPlugins,
    refuse: async (reason: string) => { refusal = reason; await host.run('modbench.plugin.sync'); },
    land: async () => { refusal = undefined; await host.run('modbench.plugin.sync'); },
  };
}

let clearedAt = 0;
function clears(client: InMemoryMEditClient, source: string): void {
  client.setQueryAnswer('getFilterCleared', { source, reason: 'Conversion Error', sequence: ++clearedAt });
  client.change(undefined);
}

function wholeRedraws(made: ReturnType<typeof pluginsOver>): () => number {
  const redrawn: unknown[] = [];
  made.view().treeDataProvider.onDidChangeTreeData?.((changed) => redrawn.push(changed));
  return () => redrawn.filter((changed) => changed === undefined).length;
}

const badgeOf = async (uri: unknown) => (await host.decorate(uri)).find((decoration) => decoration?.badge !== undefined)?.badge;

describe('the Plugins view is a tree whose rows select several at once (common.md, story 6; plugins.md)', () => {
  it('selects several rows and has Collapse All', () => {
    const { view } = pluginsOver();

    const { canSelectMany, showCollapseAll } = view().options;
    expect({ canSelectMany, showCollapseAll }).toEqual({ canSelectMany: true, showCollapseAll: true });
  });
});

describe('the Plugins view registers its own gestures', () => {
  it('runs modbench.plugin.create under its own reporter', async () => {
    const { reporter } = pluginsOver();

    await host.run('modbench.plugin.create');

    expect(reporter('newPlugin').reports.map((report) => report.message)).toEqual(['Could not look up which extensions a plugin may take.']);
  });

  it('hears its copy value in the Plugins view\'s key, and defers for any other', () => {
    const { shown } = pluginsOver();
    expect(shown.copyValue.reporterTag).toBe('pluginListTree.copyValue');
    expect(shown.copyValue.text({ view: 'modbench.modList' }, undefined)).toBeUndefined();
    expect(shown.copyValue.text({ view: 'modbench.pluginListTree' }, undefined)).toBe('');
  });
});

describe('the Plugins view\'s move from the palette', () => {
  it('offers above each row outside the selection, then the bottom of the view', async () => {
    const { rows, view } = pluginsOver({ value: found('A.esp', 'B.esp', 'C.esp') });
    const [, b] = await rows();
    view().selectRows([present(b, 'the B.esp row')]);

    await host.run('modbench.plugin.move');

    expect(picked()).toEqual([['A.esp', 'C.esp', 'Bottom of the view']]);
  });
});

describe('the Plugins view\'s selection for a key', () => {
  it('still holds a selected row the rebuilt tree shows, though VS Code reports none until the tree hands its rows back', async () => {
    const { shown, view, rows } = pluginsOver({ value: found('A.esp') });
    const focused = createFocusedView();
    focused.follow('modbench.pluginListTree', shown.followed);
    const [row] = await rows();

    view().selectRows([present(row, 'the plugin row')]);
    expect(view().selection).toEqual([row]);
    Object.assign(view(), { selection: [] });

    expect(focused.selectionOf('modbench.pluginListTree')).toEqual([row]);
  });
});

describe('the Plugins view says its one selected row to Symbols (commands.md, `go to` and `referenced by` under Symbol)', () => {
  const shownWith = () => instanceValueFixture({
    plugins: pluginsOf(['A.esp', 'B.esp'], 'SomeMod'), gameFolder: FOUND,
    pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }],
  });

  it('names the one selected plugin, and none over several', async () => {
    const { shown, pluginRows, view } = pluginsOver({ value: shownWith() });
    const row = await pluginRows();

    view().selectRows([row('A.esp', 'SomeMod')]);
    const one = pluginArgumentOf(shown.symbolRows.selected());
    view().selectRows([row('A.esp', 'SomeMod'), row('B.esp', 'SomeMod')]);

    expect([one?.plugin, shown.symbolRows.selected()]).toEqual([{ name: 'A.esp', origin: 'SomeMod' }, undefined]);
  });

  it('names the plugin the game loads with no line', async () => {
    const { shown, pluginRows, view } = pluginsOver({ value: shownWith() });
    const row = await pluginRows();

    view().selectRows([row('Fallout4.esm', 'Data/')]);

    expect(pluginArgumentOf(shown.symbolRows.selected())?.plugin).toEqual({ name: 'Fallout4.esm', origin: 'Data/' });
  });
});

describe('the Plugins view\'s selection relates to its masters (plugins.md, The highlight, story 4)', () => {
  it('names the row of each master mEdit read from the selected plugin', async () => {
    const client = clientHoldingNothing();
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'Dep.esp', origin: 'SomeMod', masters: ['Base.esm'] })]);
    const { shown, rows } = pluginsOver({ value: found('Dep.esp', 'Base.esm'), client });
    await handedOff(client);
    const [dep] = await rows();
    changeNamesPlugin(client, { name: 'Dep.esp', origin: 'SomeMod' });
    await settled(() => { expect(pluginReads(client)).toBe(1); });
    await settle();

    expect(shown.relatesRows.related([present(dep, 'the Dep.esp row')]).plugins).toEqual([{ name: 'Base.esm', origin: 'SomeMod' }]);
  });
});

describe('the Plugins view\'s selection and the highlight (plugins.md, The highlight, stories 3 and 6)', () => {
  const value = () => instanceValueFixture({ mods: [{ kind: 'mod', name: 'SomeMod', enabled: true }], plugins: pluginsOf(['A.esp', 'B.esp'], 'SomeMod'), gameFolder: FOUND });

  it('relates a selected plugin to the mod it comes from', async () => {
    const { shown, rows } = pluginsOver({ value: value() });
    const [a] = await rows();

    expect(shown.relatesRows.related([present(a, 'the A.esp row')]).origins).toEqual([{ kind: 'mod', name: 'SomeMod' }]);
  });

  it('marks the label of the plugin rows it is handed', async () => {
    const { shown, rows, item } = pluginsOver({ value: value() });

    shown.drawsHighlight.highlight({ plugins: [{ name: 'B.esp', origin: 'SomeMod' }], origins: [] });

    const labels = await Promise.all((await rows()).map(async (row) => (await item(row)).label));
    expect(labels.flatMap((label) => (typeof label === 'object' && label.highlights !== undefined ? [label.label] : []))).toEqual(['1 B.esp']);
  });
});

describe('the Plugins view follows mEdit\'s change event', () => {
  async function changing() {
    const made = await indexedOver(['Test.esp', 'Other.esp']);
    const uris = await Promise.all([made.row('Test.esp'), made.row('Other.esp')].map(async (row) => (await made.item(row)).resourceUri));
    await Promise.all(uris.map((uri) => host.decorate(uri)));
    made.client.calls.length = 0;
    const redrawn: unknown[] = [];
    made.view().treeDataProvider.onDidChangeTreeData?.((element) => redrawn.push(element));
    return { ...made, uris, redrawn, decorationChanges: host.decorationChanges() };
  }

  it('redraws only the named plugin\'s row, and re-reads only its records and its facts, with no diagnosis scan', async () => {
    const { client, row, uris, redrawn, decorationChanges } = await changing();

    client.change(rowsChanged());

    await settled(() => { expect(pluginReads(client)).toBe(1); });
    await settle();
    expect(new Set(redrawn)).toEqual(new Set([row('Test.esp')]));
    expect(decorationChanges).toEqual([[uris[0]]]);
    expect(client.calls.filter(({ method }) => method !== 'getPluginsIndexing').map(({ method, args }) => [method, args])).toEqual([['getPlugins', [[TEST_PLUGIN]]]]);
  });

  it('redraws every row, and re-reads every plugin\'s records, when the change names none', async () => {
    const { client, redrawn, decorationChanges } = await changing();

    client.change(undefined);

    await settled(() => { expect(pluginReads(client)).toBe(1); });
    expect(redrawn).toContain(undefined);
    expect(decorationChanges).toContain(undefined);
  });

  it('hears no push once disposed', async () => {
    const { client, dispose } = await changing();

    dispose();
    client.change(rowsChanged());
    await settle();

    expect(client.calls).toEqual([]);
  });
});

describe('the Plugins view re-renders for a reconcile tick only when it landed something new, since a re-render re-fetches record types for every expanded row', () => {
  const A = { name: 'A.esp', origin: 'SomeMod' };

  function reconciling() {
    const made = pluginsOver();
    const rerenders: unknown[] = [];
    made.view().treeDataProvider.onDidChangeTreeData?.((changed) => rerenders.push(changed));
    return { client: made.client, rerenders };
  }

  it('re-renders for a tick that landed a new plugin', async () => {
    const { client, rerenders } = reconciling();

    holdsLoadOrder(client, { settled: false, total: 3, indexed: [A] });

    await settled(() => { expect(rerenders).toHaveLength(1); });
  });

  it('does not re-render for a tick that landed nothing new', async () => {
    const { client, rerenders } = reconciling();

    holdsLoadOrder(client, { settled: false, total: 3, indexed: [A] });
    holdsLoadOrder(client, { settled: false, total: 3, indexed: [A] });
    holdsLoadOrder(client, { settled: false, total: 3, indexed: [A] });
    await settle();

    expect(rerenders).toHaveLength(1);
  });

  it('re-renders for a tick that landed a failure though no plugin was indexed, since a failed plugin never joins the indexed set', async () => {
    const { client, rerenders } = reconciling();

    holdsLoadOrder(client, { settled: false, total: 3, indexed: [A] });
    await settle();
    const afterTheFirst = rerenders.length;
    holdsLoadOrder(client, { settled: false, total: 3, indexed: [A], failures: [{ name: 'B.esp', origin: 'SomeMod', reason: 'RACE parse' }] });

    await settled(() => { expect(rerenders.slice(afterTheFirst)).toContain(undefined); });
  });
});

describe('the Plugins view\'s Problems', () => {
  const inModA = (path: string) => instanceValueFixture({ plugins: [{ name: 'Test.esp', path, origin: 'ModA', line: 0, enabled: true, winning: true }] });
  const severities = (name: string) => host.problems(name).map(([path, shown]) => [path, shown.map(({ message, severity }) => [message, severity])]);

  it('puts a plugin changed outside Modbench on its row\'s own file, at the name it has on disk', async () => {
    const onDisk = '/instance/mods/ModA/test.ESP';
    const { client } = pluginsOver({ value: inModA(onDisk) });

    holdsLoadOrder(client);
    client.setQueryAnswer('getPluginsIndexing', [{ name: 'Test.esp', origin: 'ModA', state: 'Indexed', changedOutside: true }]);
    client.change([{ plugin: TEST_PLUGIN }]);

    await settled(() => {
      expect(host.problems('modbench-changed-outside').map(([path, shown]) => [path, shown.map(({ severity }) => severity)])).toEqual([[onDisk, [DiagnosticSeverity.Warning]]]);
    });
  });

  it('puts the diagnosis of a failed read on its row\'s own file as an error, and a malformed plugin\'s as a warning', async () => {
    const onDisk = '/instance/mods/ModA/Test.esp';
    const { client } = pluginsOver({ value: inModA(onDisk) });
    client.setQueryAnswer('getDiagnoses', [{ plugin: 'Test.esp', origin: 'ModA', text: 'short' }]);

    holdsLoadOrder(client, { total: 3, failures: [{ name: 'Test.esp', origin: 'ModA', reason: 'Could not read this plugin.', diagnosis: 'duplicate FormKey' }] });

    await settled(() => {
      expect(severities('modbench-failed-to-read')).toEqual([[onDisk, [['duplicate FormKey', DiagnosticSeverity.Error]]]]);
      expect(severities('modbench-diagnosis')).toEqual([[onDisk, [['short', DiagnosticSeverity.Warning]]]]);
    });
  });

  it('groups several diagnoses of one plugin on its one file, in the order mEdit answers them', async () => {
    const onDisk = '/instance/mods/ModA/Test.esp';
    const { client } = pluginsOver({ value: inModA(onDisk) });
    client.setQueryAnswer('getDiagnoses', [{ plugin: 'Test.esp', origin: 'ModA', text: 'first' }, { plugin: 'Test.esp', origin: 'ModA', text: 'second' }]);

    holdsLoadOrder(client, { total: 3 });

    await settled(() => { expect(severities('modbench-diagnosis')).toEqual([[onDisk, [['first', DiagnosticSeverity.Warning], ['second', DiagnosticSeverity.Warning]]]]); });
  });

  it('puts nothing on a plugin the load order holds no file of', async () => {
    const { client } = pluginsOver({ value: inModA('/instance/mods/ModA/Test.esp') });
    client.setQueryAnswer('getDiagnoses', [{ plugin: 'Ghost.esp', origin: 'Gone', text: 'bad' }, { plugin: 'Test.esp', origin: 'ModA', text: 'short' }]);

    holdsLoadOrder(client, { total: 3 });

    await settled(() => { expect(host.problems('modbench-diagnosis').map(([path]) => path)).toEqual(['/instance/mods/ModA/Test.esp']); });
  });

  it('replaces the diagnoses of the last scan wholesale, for one scan answers for the whole load order', async () => {
    const value = instanceValueFixture({ plugins: pluginsOf(['A.esp', 'B.esp']) });
    const { client } = pluginsOver({ value });
    client.setQueryAnswer('getDiagnoses', [{ plugin: 'A.esp', origin: 'ModA', text: 'old' }]);
    holdsLoadOrder(client, { total: 3, version: 1 });
    await settled(() => { expect(host.problems('modbench-diagnosis').map(([path]) => path)).toEqual(['/mods/ModA/A.esp']); });

    client.setQueryAnswer('getDiagnoses', [{ plugin: 'B.esp', origin: 'ModA', text: 'new' }]);
    holdsLoadOrder(client, { total: 3, version: 2 });

    await settled(() => { expect(host.problems('modbench-diagnosis').map(([path]) => path)).toEqual(['/mods/ModA/B.esp']); });
  });

  const linkTo = (command: string) => ({
    value: command === 'decompile' ? 'decompile' : 'decompile and repair',
    target: Uri.parse(`command:modbench.plugin.${command}?${encodeURIComponent(JSON.stringify([{ name: 'Test.esp', origin: 'ModA' }]))}`),
  });
  const placed = (origin: string, listedSourceMods: readonly string[] = []) => instanceValueFixture({
    mods: [{ kind: 'mod', name: 'ModA', enabled: true }], listedSourceMods: new Set(listedSourceMods),
    plugins: [{ name: 'Test.esp', path: '/instance/Test.esp', origin, line: 0, enabled: true, winning: true }],
  });

  it.each([
    ['a mod', placed('ModA'), [linkTo('decompileAndRepair')]],
    ['a source mod', placed('ModA', ['ModA']), [linkTo('decompileAndRepair')]],
    ['the game folder, since no mod can hold its source', placed('Data/'), [undefined]],
    ['Overwrite, since no mod can hold its source', placed('overwrite/'), [undefined]],
  ])('links a malformed plugin\'s entry to decompile and repair of that plugin, or not, in %s', async (_place, value, codes) => {
    const { client } = pluginsOver({ value });
    const origin = value.plugins[0]?.origin ?? '';
    client.setQueryAnswer('getDiagnoses', [{ plugin: 'Test.esp', origin, text: 'short' }]);

    holdsLoadOrder(client, { total: 3 });

    await settled(() => { expect(host.problems('modbench-diagnosis').map(([, shown]) => shown.map(({ code }) => code))).toEqual([codes]); });
  });

  it.each([
    ['links it to decompile of that plugin where decompile repairs it', true, [linkTo('decompile')]],
    ['links it to nothing where decompile does not repair it', false, [undefined]],
  ])('puts a plugin source unreadable on its row\'s own file, and %s', async (_case, decompileRepairs, codes) => {
    const { client } = pluginsOver({ value: placed('ModA') });
    client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'Test.esp', origin: 'ModA', pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs } })]);

    holdsLoadOrder(client, { total: 3 });

    await settled(() => {
      expect(host.problems('modbench-source-unreadable').map(([path, shown]) => [path, shown.map(({ message, code }) => [message, code])]))
        .toEqual([['/instance/Test.esp', codes.map((code) => ['Plugin source unreadable: Its folder is gone.', code])]]);
    });
  });

  describe('a plugin changed outside Modbench, heard of by name', () => {
    const A = { name: 'A.esp', origin: 'ModA' };
    const B = { name: 'B.esp', origin: 'ModA' };
    const indexing = (...changedOutside: readonly { name: string; origin: string }[]) =>
      changedOutside.map((plugin) => ({ ...plugin, state: 'Indexed' as const, changedOutside: true }));

    async function bothChangedOutside() {
      const value = instanceValueFixture({ plugins: pluginsOf(['A.esp', 'B.esp']) });
      const instance = new FakeInstance(value);
      const { client } = pluginsOver({ value, instance });
      holdsLoadOrder(client);
      client.setQueryAnswer('getPluginsIndexing', indexing(A, B));
      client.change([{ plugin: A }, { plugin: B }]);
      await settled(() => { expect(host.problems('modbench-changed-outside').map(([path]) => path).sort()).toEqual(['/mods/ModA/A.esp', '/mods/ModA/B.esp']); });
      return { client, instance, value };
    }

    it('replaces the problems of only the plugins the change names, keeping the others\'', async () => {
      const { client } = await bothChangedOutside();
      client.setQueryAnswer('getPluginsIndexing', [{ ...A, state: 'Indexed', changedOutside: false }]);

      client.change([{ plugin: A }]);

      await settled(() => { expect(host.problems('modbench-changed-outside').map(([path]) => path)).toEqual(['/mods/ModA/B.esp']); });
    });

    it('clears the problems of a plugin the change names where they were set, though the load order holds no file of it now', async () => {
      const { client, instance, value } = await bothChangedOutside();
      instance.publish({ ...value, plugins: value.plugins.filter(({ name }) => name !== 'A.esp') });
      client.setQueryAnswer('getPluginsIndexing', []);

      client.change([{ plugin: A }]);

      await settled(() => { expect(host.problems('modbench-changed-outside').map(([path]) => path)).toEqual(['/mods/ModA/B.esp']); });
    });
  });
});

describe('a record row\'s badge, from mEdit\'s stream', () => {
  const FORM_KEY = '000001:Test.esp';
  const summary = (workingTreeState: RecordSummary['workingTreeState']): RecordSummary => ({
    formKey: FORM_KEY, plugin: 'Test.esp', loadOrderIndex: 0, isWinner: true, editorId: 'TestNpc', origin: 'ModA',
    workingTreeState, hasContainerChildren: false, hasParseFailure: false,
  });

  it('arrives as an M, and a change notice for the row, when mEdit reports the row changed', async () => {
    const { client, rows, row, item } = await indexedOver(['Test.esp']);
    client.setQueryAnswer('getRecords', { items: [summary('None')], total: 1 });
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'NPC_', displayName: 'Non-Player Character' })]);
    const [group] = await rows(row('Test.esp'));
    const uri = (await item(present((await rows(group))[0], 'the record row'))).resourceUri;
    const changes = host.decorationChanges();
    expect(await badgeOf(uri)).toBeUndefined();

    client.setQueryAnswer('getRecords', { items: [summary('Modified')], total: 1 });
    client.change(rowsChanged([FORM_KEY]));
    await settled(() => { expect(changes).toContainEqual([uri]); });
    await rows(group);

    expect(changes).toEqual([[uri], [uri]]);
    expect(await badgeOf(uri)).toBe('M');
  });
});

describe('the Plugins view\'s progress', () => {
  const NO_MATCH = 'No matches for "zzznomatch".';
  async function held() {
    const made = pluginsOver({ value: found('TestMod.esp') });
    await made.rows();
    made.shown.nameFilter.open();
    present(host.inputBox(), 'the name filter').type('zzznomatch');
    await waitForMessage(made.view(), (message) => message === NO_MATCH, 'the name filter\'s message');
    return made;
  }

  it('takes the message line without asking the name filter', async () => {
    const { view, shown } = await held();

    shown.say('Starting backend…');
    await settle();

    expect(view().message).toBe('Starting backend…');
  });

  it('gives a cleared line back to the name filter', async () => {
    const { view, shown } = await held();
    shown.say('Starting backend…');

    shown.say(undefined);

    await waitForMessage(view(), (message) => message === NO_MATCH, 'the name filter\'s message again');
  });

  it('clears the line when the work it runs fails', async () => {
    const { view, shown } = await held();

    await expect(shown.editingInPluginsView.around(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    await waitForMessage(view(), (message) => message === NO_MATCH, 'the name filter\'s message again');
  });
});

describe('the record filter, from the commands that set and clear it', () => {
  function filtering() {
    const made = pluginsOver();
    const { client } = made;
    client.setQueryAnswer('setFilter', null);
    client.setQueryAnswer('clearFilter', null);
    const redraws = wholeRedraws(made);
    return {
      client, redraws,
      reporter: made.reporter('recordFilter'),
      description: () => made.view().description,
      lensOn: (sql: string) => host.lenses(sql)[0]?.command?.command,
      filterActive: () => host.context('modbench.record.filterActive'),
      pluginReadsAre: (count: number) => settled(() => { expect(pluginReads(client)).toBe(count); }),
      filter: (source?: unknown) => host.run('modbench.record.filter', ...(source === undefined ? [] : [source])),
      clearFilter: () => host.run('modbench.record.clearFilter'),
      setCalls: () => client.calls.filter((call) => call.method === 'setFilter'),
      activeFilterReads: () => client.calls.filter((call) => call.method === 'getActiveFilter').length,
      holds: (source: string) => client.setQueryAnswer('getActiveFilter', { sql: ARMOR_SQL, source }),
    };
  }

  describe('modbench.record.filter, from the picker', () => {
    it('lists the workspace\'s .sql files and no other, then New filter… last', async () => {
      const { filter } = filtering();
      host.files.set('armor.sql', ARMOR_SQL).set('notes.py', '').set('weapons.sql', '');

      await filter();

      expect(picked()).toEqual([['armor.sql', 'weapons.sql', '$(add) New filter…']]);
    });

    it('applies nothing on Esc', async () => {
      const view = filtering();
      host.files.set('armor.sql', ARMOR_SQL);

      await view.filter();

      expect(view.setCalls()).toEqual([]);
      expect(view.description()).toBeUndefined();
      expect(view.filterActive()).toEqual([]);
      expect(view.redraws()).toBe(0);
    });

    it('applies a picked file\'s SQL, named by the file, and re-reads the records and the matching plugins', async () => {
      const view = filtering();
      host.files.set('armor.sql', ARMOR_SQL);
      host.picks((labels) => labels[0]);
      await handedOff(view.client);
      const before = view.redraws();
      view.holds('armor.sql');

      await view.filter();

      expect(view.setCalls()).toEqual([{ method: 'setFilter', args: [{ sql: ARMOR_SQL, source: 'armor.sql' }] }]);
      expect(view.description()).toBe('records: armor.sql');
      expect(view.lensOn(ARMOR_SQL)).toBe('modbench.record.clearFilter');
      expect(view.filterActive()).toEqual([true]);
      expect(view.redraws()).toBeGreaterThan(before);
      await view.pluginReadsAre(1);
    });

    it('opens an untitled SQL document for New filter…, and applies nothing', async () => {
      const view = filtering();
      host.picks((labels) => labels.at(-1));

      await view.filter();

      expect(host.opened).toEqual([{ language: 'sql' }]);
      expect(host.shown).toEqual([expect.objectContaining({ uri: UNTITLED })]);
      expect(view.setCalls()).toEqual([]);
      expect(view.description()).toBeUndefined();
    });
  });

  describe('modbench.record.filter, from a document', () => {
    it('applies the document\'s text, named by the document, without asking', async () => {
      const view = filtering();
      view.holds('Untitled-1');

      await view.filter(documentAt('Untitled-1'));

      expect(picked()).toEqual([]);
      expect(view.setCalls()).toEqual([{ method: 'setFilter', args: [{ sql: ARMOR_SQL, source: 'Untitled-1' }] }]);
      expect(view.description()).toBe('records: Untitled-1');
    });

    it('reports a refused set and shows what mEdit holds', async () => {
      const view = filtering();
      view.client.setQueryAnswer('setFilter', 'Filter SQL must return a form_key column');
      view.holds('older.sql');

      await view.filter(documentAt('Untitled-1', 'SELECT editor_id FROM "npc_"'));

      expect(view.reporter.reports).toEqual([
        { severity: 'error', message: 'Filter failed — Filter SQL must return a form_key column', detail: undefined },
      ]);
      expect(view.description()).toBe('records: older.sql');
    });

    it('reports a read of what mEdit holds that fails after a set that succeeded, and keeps the view', async () => {
      const view = filtering();
      view.client.setQueryFailure('getActiveFilter', { failed: 'refused', refusal: 'boom' });

      await view.filter(documentAt('Untitled-1'));

      expect(view.reporter.reports).toEqual([{ severity: 'error', message: 'Could not read the record filter', detail: 'boom' }]);
      expect(view.description()).toBeUndefined();
      expect(view.filterActive()).toEqual([]);
    });
  });

  describe('a record filter the record index could not apply again', () => {
    const warned = [{ severity: 'warning', message: 'The record filter a was cleared', detail: 'Conversion Error' }];

    async function showingA() {
      const view = filtering();
      view.holds('a');
      await view.filter(documentAt('a'));
      return { ...view, before: view.redraws() };
    }

    it('shows what mEdit holds, re-reads the records, and warns naming the source and the reason', async () => {
      const view = await showingA();
      view.client.setQueryAnswer('getActiveFilter', null);

      clears(view.client, 'a');

      await settled(() => { expect(view.reporter.reports).toEqual(warned); });
      expect(view.description()).toBeUndefined();
      expect(view.lensOn(ARMOR_SQL)).toBe('modbench.record.filter');
      expect(view.filterActive()).toEqual([true, false]);
      expect(view.redraws()).toBeGreaterThan(view.before);
    });

    it('keeps a newer filter mEdit holds, and only logs a clearing of an older one', async () => {
      const view = await showingA();
      view.client.setQueryAnswer('getActiveFilter', { sql: ARMOR_SQL, source: 'a' });

      clears(view.client, 'older.sql');

      await settled(() => {
        expect(view.reporter.shownFailures).toEqual([
          { severity: 'warning', message: 'The record filter older.sql was cleared', detail: 'Conversion Error' },
        ]);
      });
      expect(view.description()).toBe('records: a');
      expect(view.reporter.reports).toEqual([]);
    });

    it('warns when the clearing of another source leaves the view without the filter it showed', async () => {
      const view = await showingA();
      view.client.setQueryAnswer('getActiveFilter', null);

      clears(view.client, 'older.sql');

      await settled(() => {
        expect(view.reporter.reports).toEqual([
          { severity: 'warning', message: 'The record filter older.sql was cleared', detail: 'Conversion Error' },
        ]);
      });
      expect(view.description()).toBeUndefined();
    });

    it('reports a clearing once however often the change says everything, and again when its content differs, whatever its sequence', async () => {
      const view = await showingA();
      view.client.setQueryAnswer('getActiveFilter', null);
      view.client.setQueryAnswer('getFilterCleared', { source: 'a', reason: 'Conversion Error', sequence: 9 });
      view.client.change(undefined);
      await settled(() => { expect(view.reporter.reports).toEqual(warned); });

      view.client.setQueryAnswer('getFilterCleared', { source: 'a', reason: 'Conversion Error', sequence: 12 });
      view.client.change(undefined);
      await settle();
      expect(view.reporter.reports).toEqual(warned);

      view.client.setQueryAnswer('getFilterCleared', { source: 'a', reason: 'Another error', sequence: 1 });
      view.client.change(undefined);

      await settled(() => { expect(view.reporter.reports).toHaveLength(2); });
    });

    it('shows no filter when the clearing outruns the reply to the set it clears', async () => {
      const view = filtering();
      let replied!: (error: string | null) => void;
      view.client.setQueryAnswerOnce('setFilter', new Promise<string | null>((resolve) => { replied = resolve; }));
      view.client.setQueryAnswer('getActiveFilter', null);
      const applying = view.filter(documentAt('a'));
      await settled(() => { expect(view.setCalls()).toHaveLength(1); });
      clears(view.client, 'a');
      await settled(() => { expect(view.reporter.reports).toEqual(warned); });
      replied(null);
      await applying;

      await settled(() => { expect(view.filterActive()).toEqual([false, false]); });
      expect(view.description()).toBeUndefined();
    });
  });

  describe('a change of everything', () => {
    it('shows what mEdit holds, and says nothing, since the reason a filter was cleared is read apart from it', async () => {
      const view = filtering();
      view.holds('a');
      await view.filter(documentAt('a'));
      view.client.setQueryAnswer('getActiveFilter', null);

      view.client.change(undefined);

      await settled(() => { expect(view.description()).toBeUndefined(); });
      expect(view.reporter.reports).toEqual([]);
    });

    it('does not ask for the filter again when the change names plugins', async () => {
      const view = filtering();
      view.holds('a');
      await view.filter(documentAt('a'));

      view.client.change(rowsChanged());
      await settle();

      expect(view.activeFilterReads()).toBe(1);
    });
  });

  describe('overlapping applies', () => {
    it('shows what mEdit holds when the earlier apply\'s reply arrives last', async () => {
      const view = filtering();
      let repliedToA!: (error: string | null) => void;
      view.client.setQueryAnswerOnce('setFilter', new Promise<string | null>((resolve) => { repliedToA = resolve; }));
      view.holds('b');
      const applyingA = view.filter(documentAt('a'));
      await settled(() => { expect(view.setCalls()).toHaveLength(1); });
      view.client.setQueryAnswerOnce('setFilter', null);
      await view.filter(documentAt('b'));

      repliedToA(null);
      await applyingA;

      expect(view.description()).toBe('records: b');
    });

    it('shows the later read when an earlier read of what mEdit holds is handled after it', async () => {
      const view = filtering();
      let readForA!: (held: { sql: string; source: string }) => void;
      view.client.setQueryAnswerOnce('getActiveFilter', new Promise((resolve) => { readForA = resolve; }));
      view.holds('b');
      const applyingA = view.filter(documentAt('a'));
      await settled(() => { expect(view.activeFilterReads()).toBe(1); });
      await view.filter(documentAt('b'));

      readForA({ sql: ARMOR_SQL, source: 'a' });
      await applyingA;

      expect(view.description()).toBe('records: b');
    });

    it('shows the new copy when the clearing of the old copy of the same source arrives during the re-apply', async () => {
      const view = filtering();
      view.holds('a');
      await view.filter(documentAt('a'));
      let replied!: (error: string | null) => void;
      view.client.setQueryAnswerOnce('setFilter', new Promise<string | null>((resolve) => { replied = resolve; }));
      const reapplying = view.filter(documentAt('a'));
      await settled(() => { expect(view.setCalls()).toHaveLength(2); });

      clears(view.client, 'a');
      await settled(() => { expect(view.activeFilterReads()).toBe(2); });
      replied(null);
      await reapplying;

      expect(view.description()).toBe('records: a');
    });
  });

  describe('modbench.record.clearFilter', () => {
    const applied = async () => {
      const view = filtering();
      view.holds('a');
      await handedOff(view.client);
      const contexts = view.filterActive().length;
      await view.filter(documentAt('a'));
      return { ...view, before: view.redraws(), filterActive: () => view.filterActive().slice(contexts) };
    };

    it('shows no filter and re-reads the records, as a set does', async () => {
      const view = await applied();
      view.client.setQueryAnswer('getActiveFilter', null);

      await view.clearFilter();

      expect(view.client.calls).toContainEqual({ method: 'clearFilter', args: [] });
      expect(view.description()).toBeUndefined();
      expect(view.lensOn(ARMOR_SQL)).toBe('modbench.record.filter');
      expect(view.filterActive()).toEqual([true, false]);
      expect(view.redraws()).toBeGreaterThan(view.before);
    });

    it('re-reads the matching plugins, as a set does', async () => {
      const view = await applied();
      await view.pluginReadsAre(1);

      await view.clearFilter();

      await view.pluginReadsAre(2);
    });

    it('reports a refused clear and keeps showing the filter', async () => {
      const view = await applied();
      view.client.setQueryAnswer('clearFilter', 'No load order has been received yet.');

      await view.clearFilter();

      expect(view.reporter.reports).toEqual([
        { severity: 'error', message: 'Could not clear the record filter — No load order has been received yet.', detail: undefined },
      ]);
      expect(view.description()).toBe('records: a');
    });

    it('shows what mEdit holds after a clear whose reply arrives last', async () => {
      const view = await applied();
      let replied!: (error: string | null) => void;
      view.client.setQueryAnswerOnce('clearFilter', new Promise<string | null>((resolve) => { replied = resolve; }));
      const clearing = view.clearFilter();
      await settled(() => { expect(view.client.calls).toContainEqual({ method: 'clearFilter', args: [] }); });
      view.holds('b');
      await view.filter(documentAt('a'));
      replied(null);
      await clearing;

      expect(view.description()).toBe('records: b');
    });
  });
});

describe('the Plugins view\'s message line and name filter', () => {
  const GAME_FOLDER_MESSAGE =
    "Game folder not found: set modbench.mods.gameFolder. The Toolbox's Game row names each place Modbench looked.";
  const heldPlugin = (name: string, hasMatchingRecords: boolean): PluginMetadata =>
    pluginMetadataFixture({ name, path: `/fixture/${name}`, hasMatchingRecords });
  const NO_MATCH = 'No matches for "zzznomatch".';
  const messageIs = (expected: string | undefined, label: string) => waitForMessage(host.treeView(), (m) => m === expected, label);

  async function applyFilter(client: InMemoryMEditClient) {
    const source = 'armor.sql';
    client.setQueryAnswer('setFilter', null);
    client.setQueryAnswer('getActiveFilter', { sql: ARMOR_SQL, source });
    await host.run('modbench.record.filter', documentAt(source));
  }

  async function shown(value: InstanceValue, over: { client?: InMemoryMEditClient; syncPlugins?: PluginSyncRun } = {}) {
    const instance = new FakeInstance(value);
    const made = pluginsOver({ value, instance, ...over });
    await made.rows();
    return { ...made, instance };
  }

  function typeNoMatch(nameFilter: { open(): void }) {
    nameFilter.open();
    present(host.inputBox(), 'the name filter').type('zzznomatch');
  }

  describe('a row change with no keystroke', () => {
    it('recomputes the no-match message off a reconcile, in both directions', async () => {
      const { shown: plugins, view, instance } = await shown(found('TestMod.esp'));

      typeNoMatch(plugins.nameFilter);
      await messageIs(NO_MATCH, 'the message after the keystroke');

      instance.publish(found('TestMod.esp', 'zzznomatch.esp'));
      await messageIs(undefined, 'the message clearing once a matching plugin lands');

      instance.publish(found('TestMod.esp'));
      await messageIs(NO_MATCH, 'the message returning once the plugin is gone');
      expect(view().message).toBe(NO_MATCH);
    });
  });

  describe('given the game folder not found', () => {
    it('says so, and keeps its rows', async () => {
      const { rows, instance } = await shown(found('TestMod.esp'));

      instance.publish(notFound('TestMod.esp'));

      await messageIs(GAME_FOLDER_MESSAGE, 'the game folder message');
      expect(await rows()).toHaveLength(1);
    });

    it('says nothing before the first read lands', async () => {
      const value = notFound();
      const { shown: plugins, view } = pluginsOver({ value, instance: new FakeInstance(value, 0) });

      plugins.nameFilter.refresh();
      await settle();

      expect(view().message).toBeUndefined();
    });
  });

  describe('given a record filter that matches nothing', () => {
    async function filteredView(testModMatches: boolean, apply: (client: InMemoryMEditClient) => Promise<void> = applyFilter) {
      const client = clientHoldingNothing();
      client.setQueryAnswer('getPlugins', [heldPlugin('Other.esp', false), heldPlugin('TestMod.esp', testModMatches)]);
      const sync = syncRefusing();
      const result = await shown(found('Other.esp', 'TestMod.esp'), { client, syncPlugins: sync.syncPlugins });
      await handedOff(client);
      await apply(client);
      return { ...result, client, sync };
    }

    const LAST_SYNC_MESSAGE = 'plugins.txt is not synced: sentinel.';
    async function lineOnceRendersHaveLanded(view: () => { message?: string }, sync: ReturnType<typeof syncRefusing>) {
      await sync.refuse('sentinel');
      await waitForMessage(view(), (m) => m?.endsWith(LAST_SYNC_MESSAGE) === true, 'the sync message reaching the line');
      return view().message;
    }

    it('says so in its message line, naming the source', async () => {
      const { view } = await filteredView(false);

      await messageIs('No records match armor.sql.', 'the no-match message');
      expect(view().message).toBe('No records match armor.sql.');
    });

    it('says nothing while no record filter is in force, whatever the facts say', async () => {
      const { view, sync } = await filteredView(false, (client) => { client.change(rowsChanged()); return Promise.resolve(); });

      expect(await lineOnceRendersHaveLanded(view, sync)).toBe(LAST_SYNC_MESSAGE);
    });

    it('takes the message back once the filter clears', async () => {
      const { client } = await filteredView(false);
      await messageIs('No records match armor.sql.', 'the no-match message');

      client.setQueryAnswer('getPlugins', [heldPlugin('Other.esp', true), heldPlugin('TestMod.esp', true)]);
      client.setQueryAnswer('clearFilter', null);
      await host.run('modbench.record.clearFilter');

      await messageIs(undefined, 'the message clearing');
    });
  });

  describe('given a plugin sync that refused', () => {
    const SYNC_REASON = "the game's Data folder cannot be listed: EACCES";
    const SYNC_MESSAGE = `plugins.txt is not synced: ${SYNC_REASON}.`;
    const NO_RECORD_MATCH = 'No records match armor.sql.';

    async function refusedView() {
      const client = clientHoldingNothing();
      client.setQueryAnswer('getPlugins', [heldPlugin('TestMod.esp', false)]);
      const sync = syncRefusing();
      const result = await shown(found('TestMod.esp'), { client, syncPlugins: sync.syncPlugins });
      await handedOff(client);
      await applyFilter(client);
      return { ...result, sync };
    }

    it('gives the agent the sync refusal, without the no-match line the view shows beside it', async () => {
      const { sync, plugins } = await refusedView();

      await sync.refuse(SYNC_REASON);
      await messageIs(`${NO_RECORD_MATCH} ${SYNC_MESSAGE}`, 'both messages');

      expect(plugins.standing.plugins()).toEqual([SYNC_MESSAGE]);
    });

    it('says it beside the view\'s own message, and drops only its own once the sync lands', async () => {
      const { sync } = await refusedView();

      await sync.refuse(SYNC_REASON);
      await messageIs(`${NO_RECORD_MATCH} ${SYNC_MESSAGE}`, 'both messages');

      await sync.land();
      await messageIs(NO_RECORD_MATCH, 'the view\'s own message alone');
    });
  });

  describe('while a load holds it', () => {
    it('gives the line back to the game folder message once the load clears it', async () => {
      const { shown: plugins, view, instance } = await shown(notFound('TestMod.esp'));

      plugins.say('Starting backend…');
      instance.publish(notFound('TestMod.esp'));
      await settle();
      expect(view().message).toBe('Starting backend…');

      plugins.say(undefined);
      await messageIs(GAME_FOLDER_MESSAGE, 'the game folder message returning');
    });
  });
});
