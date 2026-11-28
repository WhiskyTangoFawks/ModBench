import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host, TreeItem, Uri } from './vscodeHost';
import { clientHoldingNothing, indexedOver, pluginsOf, pluginsOver } from './pluginsOver';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';
import { recordSummaryFixture, recordTypeCountFixture } from '../../client/test/fixtures';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { AgentCall } from '../../drivingLib/agentGesture';
import { present } from '../../ports/present';

const plugin = (name: string, origin: string, path: string): LoadOrderPlugin =>
  ({ name, origin, path, line: null, enabled: false, winning: true });

const VALUE = instanceValueFixture({
  mods: [
    { kind: 'mod', name: 'Winning Mod', enabled: true },
    { kind: 'separator', name: 'Patches', enabled: true },
    { kind: 'mod', name: 'Disabled Mod', enabled: false },
    { kind: 'mod', name: 'Holding Mod', enabled: true },
    { kind: 'mod', name: 'Losing Mod', enabled: true },
  ],
  plugins: [plugin('MyPatch.esp', 'Holding Mod', '/instance/mods/Holding Mod/MyPatch.esp')],
  paths: {
    overwriteDir: '/instance/overwrite',
    downloadsDir: '/instance/downloads',
    modDirs: new Map([
      ['Winning Mod', '/instance/mods/Winning Mod'],
      ['Disabled Mod', '/instance/mods/Disabled Mod'],
      ['Holding Mod', '/instance/mods/Holding Mod'],
      ['Losing Mod', '/instance/mods/Losing Mod'],
    ]),
    sourceDirs: new Map([['Winning Mod', '/instance/source/Winning Mod']]),
  },
});

const WROTE = { name: 'MyPatch.esp', origin: 'Winning Mod' };
const EXTENSIONS_QUERY = { method: 'getCreatablePluginExtensions', args: [] };
const FLAGS_QUERY = { method: 'getCreatablePluginFlags', args: ['MyPatch.esp'] };
const PLACES_QUERY = { method: 'getPlacesHoldingPluginSource', args: ['MyPatch.esp'] };
const PLACES = 'Where should the new plugin live?';

interface Creating { value?: InstanceValue; extensions?: string[]; flags?: string[][]; heldAsPluginSource?: string[] }

function creating({ value = VALUE, extensions = ['.esm', '.esl', '.esp'], flags = [['Master']], heldAsPluginSource = [] }: Creating = {}) {
  const client = clientHoldingNothing();
  client.setQueryAnswer('getCreatablePluginExtensions', extensions);
  client.setQueryAnswer('getPlacesHoldingPluginSource', heldAsPluginSource);
  client.setQueryAnswer('getCreatablePluginFlags', flags);
  const instance = new FakeInstance(value);
  const made = pluginsOver({ client, instance, value });
  client.calls.length = 0;
  return {
    client, instance, reporter: made.reporter('newPlugin'),
    created: () => client.calls.filter(({ method }) => method === 'createPlugin').map(({ args }) => args),
    run: (...args: unknown[]) => host.run('modbench.plugin.create', ...args),
    places: () => host.quickPicks.filter(({ placeHolder }) => placeHolder === PLACES).map(({ items }) => items),
  };
}

function namesThenPicks(name: string | undefined, place?: string, flags?: string) {
  host.types(() => name);
  host.picks((labels) => [place, flags].find((label) => label !== undefined && labels.includes(label)));
}

describe('modbench.plugin.create', () => {
  it.each([
    ['whose plugin source mEdit says holds the name, whatever the case of its name', 'MyPatch.esp', ['winning mod'], ['Losing Mod', 'Overwrite']],
    ['that holds a plugin of that name, whatever its case', 'mypatch.ESP', [], ['Winning Mod', 'Losing Mod', 'Overwrite']],
  ])('offers the enabled mods, then Overwrite, leaving out a place %s', async (_case, name, heldAsPluginSource, offered) => {
    const { run, places } = creating({ heldAsPluginSource });
    namesThenPicks(name);

    await run();

    expect(places()).toEqual([offered]);
  });

  it.each([
    ['a mod with a source folder, sending it', 'Winning Mod', 'Winning Mod', ['/instance/mods/Winning Mod', '/instance/source/Winning Mod']],
    ['a mod with none', 'Losing Mod', 'Losing Mod', ['/instance/mods/Losing Mod', undefined]],
    ['Overwrite', 'Overwrite', 'overwrite/', ['/instance/overwrite', undefined]],
  ])('creates the plugin in %s, at its folder, under the Plugins bar, and lands the created toast', async (_case, label, origin, folders) => {
    const { client, run, reporter } = creating();
    client.setCommandResult('createPlugin', { name: 'MyPatch.esp', origin });
    namesThenPicks('MyPatch.esp', label);

    await run();

    expect(client.calls).toEqual([
      EXTENSIONS_QUERY, PLACES_QUERY, FLAGS_QUERY,
      { method: 'createPlugin', args: [{ name: 'MyPatch.esp', origin }, ...folders, ['Master']] },
    ]);
    expect(host.progress).toEqual(['opens on modbench.pluginListTree', 'closes']);
    expect(reporter.landings).toEqual([`Created "MyPatch.esp" in ${label}.`]);
    expect(reporter.reports).toEqual([]);
  });

  it('picks the header flags from the combinations offered, and creates the header flagged as picked', async () => {
    const { client, run, created } = creating({ flags: [[], ['Master'], ['Small'], ['Master', 'Medium']] });
    client.setCommandResult('createPlugin', WROTE);
    namesThenPicks('MyPatch.esp', 'Winning Mod', 'Light');

    await run();

    expect(host.quickPicks.at(-1)?.items).toEqual(['No flags', 'ESM', 'Light', 'ESM, Medium']);
    expect(created().map((args) => args.at(-1))).toEqual([['Small']]);
  });

  it('creates nothing when Esc answers the flags pick', async () => {
    const { run, created, reporter } = creating({ flags: [[], ['Master']] });
    namesThenPicks('MyPatch.esp', 'Winning Mod');

    await run();

    expect(created()).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it.each([
    ['which places\' plugin source holds the name, and offers no place', 'getPlacesHoldingPluginSource', 'The record index is reading.',
      'Could not look up which places\' plugin source holds "MyPatch.esp".', [EXTENSIONS_QUERY, PLACES_QUERY], 1],
    ['which header flags the plugin may take, and creates nothing', 'getCreatablePluginFlags', 'MyPatch.esp is not a plugin file name.',
      'Could not look up which header flags "MyPatch.esp" may take.', [EXTENSIONS_QUERY, PLACES_QUERY, FLAGS_QUERY], 1],
    ['which extensions a plugin may take, and opens no prompt', 'getCreatablePluginExtensions', 'No load order has been loaded.',
      'Could not look up which extensions a plugin may take.', [EXTENSIONS_QUERY], 0],
  ] as const)('reports why when mEdit cannot say %s', async (_case, query, refusal, message, calls, prompts) => {
    const { client, run, reporter } = creating();
    client.setQueryFailure(query, { failed: 'refused', refusal });
    namesThenPicks('MyPatch.esp', 'Winning Mod');

    await run();

    expect(client.calls).toEqual(calls);
    expect(host.inputsAsked).toHaveLength(prompts);
    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: refusal }]);
  });

  it('refuses an extension mEdit leaves out inline, naming the ones it allows', async () => {
    const { run } = creating({ extensions: ['.esm', '.esp'] });

    await run();

    expect(await present(host.inputsAsked[0], 'the name prompt').validateInput?.('MyPatch.esl')).toBe('Extension must be .esm or .esp');
  });

  it.each([
    ['the name prompt, and asks for no place', undefined, [EXTENSIONS_QUERY]],
    ['the place pick', 'MyPatch.esp', [EXTENSIONS_QUERY, PLACES_QUERY]],
  ])('creates nothing when Esc answers %s', async (_case, name, calls) => {
    const { client, run, reporter } = creating();
    namesThenPicks(name);

    await run();

    expect(client.calls).toEqual(calls);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it.each<[string, (value: InstanceValue) => InstanceValue, string]>([
    ['vanished, naming it', (value) => ({ ...value, mods: [], paths: { ...value.paths, modDirs: new Map() } }),
      'The mod "Winning Mod" is gone, so "MyPatch.esp" was not created.'],
    ['was disabled, saying so', (value) => ({ ...value, mods: [{ kind: 'mod', name: 'Winning Mod', enabled: false }] }),
      'The mod "Winning Mod" was disabled, so "MyPatch.esp" was not created.'],
  ])('refuses a mod that %s between the pick and the answer, and creates nothing', async (_what, changed, message) => {
    const { client, instance, run, reporter } = creating();
    host.types(() => 'MyPatch.esp');
    host.picks(() => { instance.value = changed(instance.value); return 'Winning Mod'; });

    await run();

    expect(client.calls).toEqual([EXTENSIONS_QUERY, PLACES_QUERY]);
    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: undefined }]);
  });

  it('reports the refusal mEdit answered with at error, and lands no toast', async () => {
    const { client, run, reporter } = creating();
    client.setCommandResult('createPlugin', { refused: true, message: 'Could not create "MyPatch.esp" — A file is already there.' });
    namesThenPicks('MyPatch.esp', 'Overwrite');

    await run();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not create "MyPatch.esp" — A file is already there.', detail: undefined }]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports that every place holds the name, and offers no empty pick', async () => {
    const { run, reporter } = creating({
      value: {
        ...VALUE,
        mods: [{ kind: 'mod', name: 'Holding Mod', enabled: true }],
        plugins: [...VALUE.plugins, plugin('MyPatch.esp', 'overwrite/', '/instance/overwrite/MyPatch.esp')],
      },
    });
    namesThenPicks('MyPatch.esp');

    await run();

    expect(host.quickPicks).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Overwrite and every enabled mod already hold "MyPatch.esp".', detail: undefined }]);
  });
});

describe('modbench.plugin.create, called by the agent', () => {
  const place = (origin: string, flags?: string[]) =>
    new AgentCall([origin === 'overwrite/' ? { kind: 'runtimeOutput' } : { kind: 'mod', name: origin }], { name: 'MyPatch.esp', flags });

  it.each([
    ['the place given', 'Winning Mod', ['Small']],
    ['a mod named with other case, addressing it by the origin the place resolved to,', 'winning mod', undefined],
  ])('creates the plugin named in %s, opening and reporting nothing, and answers the outcome', async (_case, origin, flags) => {
    const { client, run, reporter } = creating();
    client.setCommandResult('createPlugin', WROTE);

    const answered = await run(place(origin, flags));

    expect(client.calls).toEqual([{ method: 'createPlugin', args: [WROTE, '/instance/mods/Winning Mod', '/instance/source/Winning Mod', flags] }]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [WROTE], refused: [] } });
    expect([host.inputsAsked, host.quickPicks, reporter.reports, reporter.landings]).toEqual([[], [], [], []]);
  });

  it('answers the refusal mEdit gave, with its reason and reporting nothing', async () => {
    const { client, run, reporter } = creating();
    client.setCommandResult('createPlugin', { refused: true, message: 'A file is already there.' });

    expect(await run(place('Winning Mod'))).toEqual({ applied: false, refusal: 'A file is already there.' });
    expect(reporter.reports).toEqual([]);
  });

  it.each([
    ['names no place', new AgentCall([], { name: 'MyPatch.esp' }), {}, 'Create a plugin in one mod or Overwrite.'],
    ['names two places', new AgentCall([{ kind: 'mod', name: 'Winning Mod' }, { kind: 'runtimeOutput' }], { name: 'MyPatch.esp' }), {},
      'Create a plugin in one mod or Overwrite.'],
    ['names what is not a place', new AgentCall([{ kind: 'profile', name: 'Default' }], { name: 'MyPatch.esp' }), {}, 'carries mod or runtimeOutputs only'],
    ['names a place that is not an enabled mod, whatever its case', place('disabled mod'), {}, '"disabled mod" is not enabled, so "MyPatch.esp" was not created.'],
    ['names a mod the value does not list', place('Uninstalled'), {}, 'The mod "Uninstalled" is gone, so "MyPatch.esp" was not created.'],
    ['names a place that already holds the name', place('Holding Mod'), {}, '"Holding Mod" already holds "MyPatch.esp".'],
    ['names an Overwrite whose folder is unread', place('overwrite/'), { overwriteDir: undefined }, 'Overwrite has no folder yet, so "MyPatch.esp" was not created.'],
  ])('refuses a call that %s, creating nothing', async (_what, call, paths, reason) => {
    const { client, run } = creating({ value: { ...VALUE, paths: { ...VALUE.paths, ...paths } } });

    await expect(run(call)).rejects.toThrow(reason);

    expect(client.calls).toEqual([]);
  });
});

describe('modbench.plugin.reveal', () => {
  async function revealing() {
    const value = instanceValueFixture({
      plugins: pluginsOf(['A.esp', 'B.esp']),
      pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }],
    });
    const instance = new FakeInstance(value);
    const made = pluginsOver({ value, instance });
    const row = await made.pluginRows();
    return {
      row, reporter: made.reporter('pluginListTree.revealInExplorer'),
      run: (...args: unknown[]) => host.run('modbench.plugin.reveal', ...args),
      select: (...rows: unknown[]) => { made.view().selectRows(rows); },
      forget: () => { instance.publish({ ...value, plugins: [], pluginsLoadedWithNoLine: [] }); },
    };
  }

  it.each([
    ['a locked row\'s file, resolved from the row', [true], 'Fallout4.esm', 'Data/', '/game/Data/Fallout4.esm'],
    ['the one selected locked row from the palette', [], 'Fallout4.esm', 'Data/', '/game/Data/Fallout4.esm'],
    ['a plugin row\'s file', [true], 'A.esp', 'ModA', '/mods/ModA/A.esp'],
    ['the one selected plugin from the palette', [], 'A.esp', 'ModA', '/mods/ModA/A.esp'],
  ])('reveals %s in the OS explorer and says nothing', async (_what, clicked, name, origin, fsPath) => {
    const { row, run, select, reporter } = await revealing();
    select(row(name, origin));

    await run(...clicked.map(() => row(name, origin)));

    expect(host.executed).toEqual([['revealFileInOS', Uri.file(fsPath)]]);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it.each([
    ['a locked row', 'Fallout4.esm', 'Data/', 'Could not resolve a file location for "Fallout4.esm" — the instance does not list this file.'],
    ['a plugin row', 'A.esp', 'ModA', 'Could not resolve a file location for "A.esp" — no mod or Overwrite holds this file.'],
  ])('reports at error why %s resolves to no file, and reveals nothing', async (_what, name, origin, message) => {
    const { row, run, forget, reporter } = await revealing();
    const shown = row(name, origin);
    forget();

    await run(shown);

    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: undefined }]);
    expect(host.executed).toEqual([]);
  });

  it('reveals nothing from the palette over a selection of several plugins', async () => {
    const { row, run, select } = await revealing();
    select(row('A.esp'), row('B.esp'));

    await run();

    expect(host.executed).toEqual([]);
  });

  it('reports a rejected reveal at error with the thrown message as its detail', async () => {
    const { row, run, reporter } = await revealing();
    host.fails('revealFileInOS', new Error('no file manager'));

    await run(row('A.esp'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to reveal "A.esp" in Explorer.', detail: 'no file manager' }]);
  });
});

describe('the Plugins view\'s copy value', () => {
  async function copying() {
    const made = await indexedOver(['Alpha.esp'], {
      value: { pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }] },
    });
    const { client, rows, row } = made;
    client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'weap', count: 2, displayName: 'Weapon' }), recordTypeCountFixture({ type: 'wrld', count: 1 })]);
    client.setQueryAnswer('getRecords', { items: [
      recordSummaryFixture({ formKey: '000800:Alpha.esp', plugin: 'Alpha.esp', editorId: 'Gun' }),
      recordSummaryFixture({ formKey: '000801:Alpha.esp', plugin: 'Alpha.esp', editorId: null }),
    ], total: 2 });
    client.setQueryAnswer('getWorldspaces', [{ formKey: '000802:Alpha.esp', editorId: 'World', hasParseFailure: false, workingTreeState: 'None', hasChildren: true }]);
    client.setQueryAnswer('getWorldspaceBlocks', { blocks: [], topCells: [{
      formKey: '000803:Alpha.esp', editorId: 'Room', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: true, fullName: 'A Room',
      hasParseFailure: false, workingTreeState: 'None',
    }] });
    client.setQueryAnswer('getCellChildRecords', { persistent: [{
      formKey: '000804:Alpha.esp', editorId: null, baseFormKey: '000800:Alpha.esp', recordType: 'refr', hasParseFailure: false, workingTreeState: 'None',
    }], temporary: [] });
    const sole = async (parent: unknown) => present((await rows(parent))[0], 'a child row');
    const alpha = row('Alpha.esp');
    const [weapons, worlds] = await rows(alpha);
    const [gun, unnamed] = await rows(weapons);
    const world = await sole(worlds);
    const room = await sole(world);
    const placed = await sole(await sole(room));
    const locked = row('Fallout4.esm', 'Data/');
    const mixed = [alpha, gun, locked, unnamed, world, room, placed, weapons];
    made.view().selectRows(mixed);
    return { copy: made.shown.copyValue.text, gun, locked, mixed };
  }

  const LINES = [
    'Alpha.esp', 'Gun [000800:Alpha.esp]', 'Fallout4.esm', '000801:Alpha.esp',
    'World [000802:Alpha.esp]', 'Room [000803:Alpha.esp]', '000804:Alpha.esp',
  ].join('\n');

  it('copies a mixed selection right-clicked in the tree, a row that stands for neither adding nothing', async () => {
    const { copy, gun, mixed } = await copying();

    expect(copy(gun, mixed)).toBe(LINES);
  });

  it('copies the selection the Plugins key hands it', async () => {
    const { copy } = await copying();

    expect(copy({ view: 'modbench.pluginListTree' }, undefined)).toBe(LINES);
  });

  it('copies the right-clicked row alone when VS Code hands no selection with it', async () => {
    const { copy, locked } = await copying();

    expect(copy(locked, undefined)).toBe('Fallout4.esm');
  });

  it.each([
    ['no row', undefined],
    ['another view\'s key', { view: 'modbench.modList' }],
    ['a Mods row', new TreeItem('a Mods row')],
  ])('defers %s, as not the Plugins view\'s', async (_case, clicked) => {
    const { copy } = await copying();

    expect(copy(clicked, undefined)).toBeUndefined();
  });
});
