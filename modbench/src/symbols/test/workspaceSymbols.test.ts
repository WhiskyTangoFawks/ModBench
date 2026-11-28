import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { document, host } from './vscodeHost';
import { symbolsOver } from './symbolsOver';
import { mEditNames, spelledName } from './mEditNames';
import { copyDocumentsOf, copyKey as key, type CopyOnDisk } from './copyDocuments';
import type { MEditClient, PluginMetadata, RecordPage, RecordSummary } from '../../client/MEditClient';
import type { ReadFailed } from '../../wire/readFailed';
import { copyDocumentUri } from '../../textDocuments/recordDocument';

const modA = { name: 'A.esp', origin: 'ModA' };
const modB = { name: 'B.esp', origin: 'ModB' };
const inactive = { name: 'D.esp', origin: 'ModD' };
const GUN = '000900:A.esp';
const STAND = '000700:Fallout4.esm';
const GUN_FILE = '/source/ModA/plugin-source/A.esp/Gun.json';

const plugin = (address: typeof modA, over: Partial<PluginMetadata> = {}): PluginMetadata => ({
  ...address, path: `/mods/${address.origin}/${address.name}`, isLight: false, isMaster: false, isBlueprint: false, masters: [],
  isImmutable: false, inLoadOrder: true, hasMatchingRecords: true, isCompiledPlugin: true, hasParseFailure: false, pluginSourceUnreadable: null, ...over,
});

const summary = (formKey: string, address: typeof modA, editorId?: string): RecordSummary => ({
  formKey, plugin: address.name, origin: address.origin, editorId, loadOrderIndex: 0, isWinner: true,
  workingTreeState: 'None', hasContainerChildren: false, hasParseFailure: false,
});

type Search = MEditClient['searchRecords'];

function symbols(plugins: PluginMetadata[] | Error, found: RecordSummary[], files: Record<string, CopyOnDisk> = {}, searching?: (...args: Parameters<Search>) => Promise<RecordPage | ReadFailed>) {
  const { getCopyDocument, textOnFile } = copyDocumentsOf(files);
  const searchRecords = vi.fn<Search>(searching ?? ((_query, _types, scope, atMost) => {
    const searched = scope ? [scope] : (plugins instanceof Error ? [] : plugins.filter((each) => each.inLoadOrder));
    const items = found.filter((row) => searched.some((each) => row.plugin === each.name && row.origin === each.origin));
    return Promise.resolve({ items: items.slice(0, atMost ?? 20), total: items.length });
  }));
  const documentsAsked = vi.fn(getCopyDocument);
  const made = symbolsOver({
    names: mEditNames((text) => [...text.matchAll(/"FormKey": "([^"]+)"/g)].map(([spelled, formKey]) => spelledName('Declaration', text, spelled, { record: formKey }))),
    arrange: (client) => {
      if (plugins instanceof Error) client.getPlugins = () => Promise.reject(plugins);
      else client.setQueryAnswer('getPlugins', plugins);
      client.searchRecords = searchRecords;
      client.getCopyDocument = documentsAsked;
      host.holds(Object.values(files).flatMap(({ file }) => { const text = file === undefined ? undefined : textOnFile(file); return file === undefined || text === undefined ? [] : [document(file, text)]; }));
    },
  });
  const listedFor = async (query: string) => (await host.workspaceSymbols(query)).filter(({ containerName }) => containerName.includes(' ('));
  return { ...made, searchRecords, documentsAsked, listedFor };
}

const listed = (found: Awaited<ReturnType<ReturnType<typeof symbols>['listedFor']>>) => found.map(({ name, containerName, location }) => [name, containerName, location.uri.fsPath]);

describe('Go to Symbol in Workspace (symbols.md, The features, story 4)', () => {
  it('lists each copy of a record it finds, with its EditorID and FormKey, at its plugin\'s file, asking for no copy\'s document', async () => {
    const { documentsAsked, listedFor } = symbols([plugin(modA), plugin(modB)], [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)]);

    expect(listed(await listedFor('Rusty'))).toEqual([
      [`RustyGun [${GUN}]`, 'A.esp (ModA)', '/mods/ModA/A.esp'],
      [STAND, 'B.esp (ModB)', '/mods/ModB/B.esp'],
    ]);
    expect(documentsAsked).not.toHaveBeenCalled();
  });

  it('lists the copies of every active plugin and every compiled plugin, and none of a plugin that is neither (ADR-0012)', async () => {
    const vanilla = { name: 'Fallout4.esm', origin: 'Fallout4.esm' };
    const neither = { name: 'F.esp', origin: 'ModF' };
    const { listedFor } = symbols(
      [plugin(vanilla, { isCompiledPlugin: false }), plugin(modA), plugin(inactive, { inLoadOrder: false }), plugin(neither, { inLoadOrder: false, isCompiledPlugin: false })],
      [summary(GUN, vanilla, 'RustyGun'), summary(GUN, modA, 'RustyGun'), summary(GUN, inactive, 'RustyGun'), summary(GUN, neither, 'RustyGun')],
    );

    expect((await listedFor('Rusty')).map(({ containerName }) => containerName)).toEqual(['Fallout4.esm (Fallout4.esm)', 'A.esp (ModA)', 'D.esp (ModD)']);
  });

  it('searches the active plugins in one ask, and each compiled plugin outside them alone', async () => {
    const outside = plugin(inactive, { inLoadOrder: false });
    const { searchRecords, listedFor } = symbols([plugin(modA), plugin(modB), outside], []);

    await listedFor('Rusty');

    expect(searchRecords.mock.calls.map(([query, types, scope]) => [query, types, scope])).toEqual([['Rusty', [], undefined], ['Rusty', [], outside]]);
  });

  it('searches nothing once the search is cancelled', async () => {
    const { searchRecords } = symbols([plugin(modA)], [summary(GUN, modA, 'RustyGun')]);

    expect(await host.workspaceSymbols('Rusty', { isCancellationRequested: true })).toEqual([]);
    expect(searchRecords).not.toHaveBeenCalled();
  });

  it('lists at most 200 copies a search, and says how many of how many match', async () => {
    const guns = Array.from({ length: 201 }, (_, index) => summary(`${(0x900 + index).toString(16).padStart(6, '0').toUpperCase()}:A.esp`, modA, `Gun${index}`));
    const { reporter, listedFor } = symbols([plugin(modA)], guns);

    expect([(await listedFor('Gun')).length, reporter.shownFailures.map(({ message }) => message)])
      .toEqual([200, ['Go to Symbol in Workspace lists 200 of the 201 copies of records whose EditorID or FormKey holds "Gun".']]);
  });

  it.each([
    ['an EditorID', 'Rusty', 'Type more of the EditorID or FormKey to narrow the list.'],
    ['a whole FormKey, which typing more cannot narrow', GUN.toLowerCase(), undefined],
  ])('when it lists fewer than match for %s, says what typing more does', async (_case, query, detail) => {
    const { reporter, listedFor } = symbols([plugin(modA)], [], {}, () => Promise.resolve({ items: [summary(GUN, modA, 'RustyGun')], total: 31 }));

    await listedFor(query);

    expect(reporter.shownFailures.map((shown) => shown.detail)).toEqual([detail]);
  });

  it('lists what it found and writes a line for each search that failed and each copy of a plugin mEdit does not list', async () => {
    const broken = { name: 'E.esp', origin: 'ModE' };
    const { reporter, listedFor } = symbols(
      [plugin(modA), plugin(broken, { inLoadOrder: false })], [], {},
      (_query, _types, scope) => (scope === undefined
        ? Promise.resolve({ items: [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)], total: 2 })
        : Promise.reject(new Error('mEdit is down.'))),
    );

    expect((await listedFor('Rusty')).map(({ name }) => name)).toEqual([`RustyGun [${GUN}]`]);
    const message = 'Go to Symbol in Workspace left out what it could not search or open.';
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message, detail: 'E.esp (ModE): mEdit is down.' },
      { severity: 'warning', message, detail: `mEdit lists no plugin B.esp (ModB), which holds ${STAND}.` },
    ]);
  });

  it('writes a reason again each time a search meets it', async () => {
    const { reporter, listedFor } = symbols([plugin(modA)], [], {}, () => Promise.reject(new Error('mEdit is down.')));

    await listedFor('Rus');
    await listedFor('Rusty');

    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['The active plugins: mEdit is down.', 'The active plugins: mEdit is down.']);
  });

  it('lists nothing, and writes why, when it cannot list the plugins', async () => {
    const { reporter, listedFor } = symbols(new Error('mEdit is down.'), []);

    expect(await listedFor('Rusty')).toEqual([]);
    expect(reporter.shownFailures).toEqual([
      { severity: 'error', message: 'Go to Symbol in Workspace cannot list the compiled plugins.', detail: 'mEdit is down.' },
    ]);
  });
});

describe('a search for the records of some types, each once (symbols.md, The features, story 5)', () => {
  const REFERENCE = mEditNames(() => [{ kind: 'Reference', start: 12, end: 17, value: 'Rusty', validFormKeyTypes: ['ARMO', 'WEAP'] }]);

  it('asks every search for the types', async () => {
    const outside = plugin(inactive, { inLoadOrder: false });
    const searchRecords = vi.fn<Search>(() => Promise.resolve({ items: [], total: 0 }));
    symbolsOver({ names: REFERENCE, arrange: (client) => { client.setQueryAnswer('getPlugins', [plugin(modA), outside]); client.searchRecords = searchRecords; } });

    await host.complete(GUN_FILE, '{ "Armor": "Rusty|" }');

    expect(searchRecords.mock.calls.map(([, types, scope]) => [types, scope])).toEqual([[['ARMO', 'WEAP'], undefined], [['ARMO', 'WEAP'], outside]]);
  });

  it.each([
    ['each record once, complete', 3, ['RustyGun', STAND], false, []],
    ['each record once, cut, counting the records it lists', 31, ['RustyGun', STAND], true,
      ['Completion lists 2 records, from 3 of the 31 copies whose EditorID or FormKey holds "Rusty".']],
  ])('lists %s, and says in the Output what it cut', async (_case, total, labels, isIncomplete, messages) => {
    const { reporter } = symbolsOver({ names: REFERENCE, arrange: (client) => {
      client.setQueryAnswer('getPlugins', [plugin(modA), plugin(modB)]);
      client.setQueryAnswer('searchRecords', { items: [summary(GUN, modA, 'RustyGun'), summary(GUN, modB, 'RustyGun'), summary(STAND, modB)], total });
    } });

    const offered = await host.complete(GUN_FILE, '{ "Armor": "Rusty|" }');

    expect([offered?.items.map(({ label }) => label), offered?.isIncomplete, reporter.shownFailures.map(({ message }) => message)]).toEqual([labels, isIncomplete, messages]);
  });
});

describe('Go to Symbol in Workspace opens the copy the user picks (symbols.md, The features, story 4)', () => {
  it('at its own record\'s FormKey member, a child record\'s in its owner\'s file', async () => {
    const PLACED = '000901:A.esp';
    const cell = `{ "FormKey": "${GUN}", "Placed": [{ "FormKey": "${PLACED}" }] }`;
    const { listedFor } = symbols(
      [plugin(modA)], [summary(PLACED, modA, 'PlacedGun')],
      { [key(GUN, modA)]: { file: GUN_FILE, text: cell }, [key(PLACED, modA)]: { file: GUN_FILE, text: cell } },
    );
    const [placed] = await listedFor('Placed');

    const found = placed && (await host.resolveWorkspaceSymbol(placed)).location;

    expect(found && [`${found.uri.scheme}:${found.uri.path}`, cell.slice(found.range.start.character, found.range.end.character)])
      .toEqual([`modbench-child-record:${GUN_FILE}`, `"FormKey": "${PLACED}"`]);
  });

  it.each([
    ['its document states no member for it', { [key(GUN, modA)]: { file: GUN_FILE, text: '{}' } }, `${GUN_FILE} states no ${GUN} member.`],
    ['its plugin holds no copy of it', {}, `A.esp (ModA) holds no ${GUN}.`],
  ])('nowhere, and writes why, where %s', async (_case, files, detail) => {
    const { reporter, listedFor } = symbols([plugin(modA)], [summary(GUN, modA, 'RustyGun')], files);
    const [picked] = await listedFor('Rusty');

    await expect(picked && host.resolveWorkspaceSymbol(picked)).rejects.toThrow(`Go to Symbol in Workspace cannot open RustyGun [${GUN}].`);
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: `Go to Symbol in Workspace cannot open RustyGun [${GUN}].`, detail }]);
  });

  it('nowhere, and writes why, where its document cannot be opened', async () => {
    const { reporter, listedFor } = symbols([plugin(modA)], [summary(GUN, modA, 'RustyGun')], { [key(GUN, modA)]: { rendered: 'Gun.json' } });
    host.unopenable.add(copyDocumentUri({ formKey: GUN, plugin: modA }, { kind: 'Rendered', location: 'Gun.json' }).fsPath);
    const [picked] = await listedFor('Rusty');

    await expect(picked && host.resolveWorkspaceSymbol(picked)).rejects.toThrow();
    expect(reporter.shownFailures).toEqual([
      { severity: 'error', message: `Go to Symbol in Workspace cannot open RustyGun [${GUN}].`, detail: 'The file is gone.' },
    ]);
  });
});
