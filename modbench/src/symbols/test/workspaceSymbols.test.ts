import { describe, it, expect, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri }));

import type * as vscode from 'vscode';
import { workspaceSymbolsOf, type RecordSearch, type RecordSymbol } from '../workspaceSymbols';
import type { PluginMetadata, RecordSummary } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { copyDocumentsOf, copyKey as key, type CopyOnDisk } from './copyDocuments';
import { spelledIn } from './fakeSourceNames';

const modA = { name: 'A.esp', origin: 'ModA' };
const modB = { name: 'B.esp', origin: 'ModB' };
const inactive = { name: 'D.esp', origin: 'ModD' };
const GUN = '000900:A.esp';
const STAND = '000700:Fallout4.esm';
const GUN_FILE = '/source/ModA/plugin-source/A.esp/Gun.json';
const GO_TO_SYMBOL = 'Go to Symbol in Workspace';

const plugin = (address: typeof modA, over: Partial<PluginMetadata> = {}): PluginMetadata => ({
  ...address, path: `/mods/${address.origin}/${address.name}`, isLight: false, isMaster: false, isBlueprint: false, masters: [],
  isImmutable: false, inLoadOrder: true, hasMatchingRecords: true, isCompiledPlugin: true, hasParseFailure: false, pluginSourceUnreadable: null, ...over,
});

const summary = (formKey: string, address: typeof modA, editorId?: string): RecordSummary => ({
  formKey, plugin: address.name, origin: address.origin, editorId, loadOrderIndex: 0, isWinner: true,
  workingTreeState: 'None', hasContainerChildren: false, hasParseFailure: false,
});

type Client = Parameters<typeof workspaceSymbolsOf<{ getText(): string }>>[0]['client'];

function symbols(plugins: PluginMetadata[], found: RecordSummary[], files: Record<string, CopyOnDisk> = {}, answering: Partial<Client> = {}) {
  const { getCopyDocument, textOnFile } = copyDocumentsOf(files);
  const documentsAsked = vi.fn(getCopyDocument);
  const client: Client = {
    getPlugins: () => Promise.resolve(plugins),
    searchRecords: vi.fn((_query: string, _types: string[], scope?: typeof modA, atMost?: number) => {
      const searched = scope ? [scope] : plugins.filter((each) => each.inLoadOrder);
      const items = found.filter((row) => searched.some((each) => row.plugin === each.name && row.origin === each.origin));
      return Promise.resolve({ items: items.slice(0, atMost ?? 20), total: items.length });
    }),
    getRecordOwner: () => Promise.reject(new Error('A symbol names its plugin.')),
    getCopyDocument: documentsAsked,
    ...answering,
  };
  const open = (uri: vscode.Uri) => new Promise<{ getText(): string }>((resolve) => {
    const text = textOnFile(uri.path);
    if (text === undefined) throw new Error('The file is gone.');
    resolve({ getText: () => text });
  });
  const reporter = recordingReporter();
  const workspace = workspaceSymbolsOf({
    client, reporter, open, declarationIn: (text, formKey) => Promise.resolve(spelledIn(text, `"FormKey": "${formKey}"`)),
  });
  return {
    client, reporter, documentsAsked,
    symbolsFor: (query: string, cancelled = () => false) => workspace.symbolsFor(query, { gesture: GO_TO_SYMBOL, cancelled }),
    recordsFor: (query: string, search: RecordSearch) => workspace.recordsFor(query, { gesture: 'Completion', cancelled: () => false }, search),
    compiledCopiesOf: (formKey: string) => workspace.compiledCopiesOf(formKey, 'Referenced By'),
    locate: (symbol: RecordSymbol) => workspace.locate(symbol, GO_TO_SYMBOL),
  };
}

const listed = (found: readonly RecordSymbol[]) =>
  found.map(({ editorId, formKey, plugin: { name: pluginName }, pluginFile }) => ({ editorId, formKey, plugin: pluginName, pluginFile }));

describe('Go to Symbol in Workspace (symbols.md, The features, story 4)', () => {
  it('lists each copy of a record it finds, with its EditorID and FormKey, at its plugin\'s file, asking for no copy\'s document', async () => {
    const { documentsAsked, symbolsFor } = symbols([plugin(modA), plugin(modB)], [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)]);

    expect(listed(await symbolsFor('Rusty'))).toEqual([
      { editorId: 'RustyGun', formKey: GUN, plugin: 'A.esp', pluginFile: '/mods/ModA/A.esp' },
      { editorId: undefined, formKey: STAND, plugin: 'B.esp', pluginFile: '/mods/ModB/B.esp' },
    ]);
    expect(documentsAsked).not.toHaveBeenCalled();
  });

  it('lists the copies of every active plugin and every compiled plugin, and none of a plugin that is neither (ADR-0012)', async () => {
    const vanilla = { name: 'Fallout4.esm', origin: 'Fallout4.esm' };
    const neither = { name: 'F.esp', origin: 'ModF' };
    const { symbolsFor } = symbols(
      [plugin(vanilla, { isCompiledPlugin: false }), plugin(modA), plugin(inactive, { inLoadOrder: false }), plugin(neither, { inLoadOrder: false, isCompiledPlugin: false })],
      [summary(GUN, vanilla, 'RustyGun'), summary(GUN, modA, 'RustyGun'), summary(GUN, inactive, 'RustyGun'), summary(GUN, neither, 'RustyGun')],
    );

    expect(listed(await symbolsFor('Rusty')).map(({ plugin }) => plugin)).toEqual(['Fallout4.esm', 'A.esp', 'D.esp']);
  });

  it('searches the active plugins in one ask, and each compiled plugin outside them alone', async () => {
    const outside = plugin(inactive, { inLoadOrder: false });
    const { client, symbolsFor } = symbols([plugin(modA), plugin(modB), outside], []);

    await symbolsFor('Rusty');

    expect(vi.mocked(client.searchRecords).mock.calls.map(([query, types, scope]) => [query, types, scope])).toEqual([['Rusty', [], undefined], ['Rusty', [], outside]]);
  });

  it('searches nothing once the search is cancelled', async () => {
    const { client, symbolsFor } = symbols([plugin(modA)], [summary(GUN, modA, 'RustyGun')]);

    expect(await symbolsFor('Rusty', () => true)).toEqual([]);
    expect(client.searchRecords).not.toHaveBeenCalled();
  });

  it('lists at most 200 copies a search, and says how many of how many match', async () => {
    const guns = Array.from({ length: 201 }, (_, index) => summary(`${(0x900 + index).toString(16).padStart(6, '0').toUpperCase()}:A.esp`, modA, `Gun${index}`));
    const { reporter, symbolsFor } = symbols([plugin(modA)], guns);

    expect([(await symbolsFor('Gun')).length, reporter.shownFailures.map(({ message }) => message)])
      .toEqual([200, ['Go to Symbol in Workspace lists 200 of the 201 copies of records whose EditorID or FormKey holds "Gun".']]);
  });

  it.each([
    ['an EditorID', 'Rusty', 'Type more of the EditorID or FormKey to narrow the list.'],
    ['a whole FormKey, which typing more cannot narrow', GUN.toLowerCase(), undefined],
  ])('when it lists fewer than match for %s, says what typing more does', async (_case, query, detail) => {
    const { reporter, symbolsFor } = symbols([plugin(modA)], [], {}, {
      searchRecords: () => Promise.resolve({ items: [summary(GUN, modA, 'RustyGun')], total: 31 }),
    });

    await symbolsFor(query);

    expect(reporter.shownFailures.map((shown) => shown.detail)).toEqual([detail]);
  });

  it('finds a record\'s copies for Referenced By in the compiled plugins outside the load order alone', async () => {
    const { compiledCopiesOf } = symbols(
      [plugin(modA), plugin(inactive, { inLoadOrder: false })], [summary(GUN, modA, 'RustyGun'), summary(GUN, inactive, 'RustyGun')],
    );

    expect(listed(await compiledCopiesOf(GUN))).toEqual([{ editorId: 'RustyGun', formKey: GUN, plugin: 'D.esp', pluginFile: '/mods/ModD/D.esp' }]);
  });

  it('lists what it found and writes a line for each search that failed and each copy of a plugin mEdit does not list', async () => {
    const broken = { name: 'E.esp', origin: 'ModE' };
    const { reporter, symbolsFor } = symbols(
      [plugin(modA), plugin(broken, { inLoadOrder: false })], [],
      {},
      { searchRecords: (_query, _types, scope) => scope === undefined
        ? Promise.resolve({ items: [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)], total: 2 })
        : Promise.reject(new Error('mEdit is down.')) },
    );

    expect(listed(await symbolsFor('Rusty')).map(({ formKey }) => formKey)).toEqual([GUN]);
    const message = 'Go to Symbol in Workspace left out what it could not search or open.';
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message, detail: 'E.esp (ModE): mEdit is down.' },
      { severity: 'warning', message, detail: `mEdit lists no plugin B.esp (ModB), which holds ${STAND}.` },
    ]);
  });

  it('writes a reason again each time a search meets it', async () => {
    const { reporter, symbolsFor } = symbols([plugin(modA)], [], {}, { searchRecords: () => Promise.reject(new Error('mEdit is down.')) });

    await symbolsFor('Rus');
    await symbolsFor('Rusty');

    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['The active plugins: mEdit is down.', 'The active plugins: mEdit is down.']);
  });

  it('lists nothing, and writes why, when it cannot list the plugins', async () => {
    const { reporter, symbolsFor } = symbols([], [], {}, { getPlugins: () => Promise.reject(new Error('mEdit is down.')) });

    expect(await symbolsFor('Rusty')).toEqual([]);
    expect(reporter.shownFailures).toEqual([
      { severity: 'error', message: 'Go to Symbol in Workspace cannot list the compiled plugins.', detail: 'mEdit is down.' },
    ]);
  });
});

describe('a search for the records of some types, each once (symbols.md, The features, story 5)', () => {
  const OF_TYPES = { types: ['ARMO', 'WEAP'], eachRecordOnce: true };

  it('asks every search for the types', async () => {
    const outside = plugin(inactive, { inLoadOrder: false });
    const { client, recordsFor } = symbols([plugin(modA), outside], []);

    await recordsFor('Rusty', OF_TYPES);

    expect(vi.mocked(client.searchRecords).mock.calls.map(([, types, scope]) => [types, scope])).toEqual([[['ARMO', 'WEAP'], undefined], [['ARMO', 'WEAP'], outside]]);
  });

  it.each([
    ['each copy, complete', { types: [], eachRecordOnce: false }, 3, [GUN, GUN, STAND], false, []],
    ['each copy, cut', { types: [], eachRecordOnce: false }, 31, [GUN, GUN, STAND], true,
      ['Completion lists 3 of the 31 copies of records whose EditorID or FormKey holds "Rusty".']],
    ['each record once, complete', OF_TYPES, 3, [GUN, STAND], false, []],
    ['each record once, cut, counting the records it lists', OF_TYPES, 31, [GUN, STAND], true,
      ['Completion lists 2 records, from 3 of the 31 copies whose EditorID or FormKey holds "Rusty".']],
  ])('lists %s, and says in the Output what it cut', async (_case, search: RecordSearch, total, formKeys, isIncomplete, messages) => {
    const { reporter, recordsFor } = symbols([plugin(modA), plugin(modB)], [], {}, {
      searchRecords: () => Promise.resolve({ items: [summary(GUN, modA, 'RustyGun'), summary(GUN, modB, 'RustyGun'), summary(STAND, modB)], total }),
    });

    const { found, isIncomplete: cut } = await recordsFor('Rusty', search);

    expect([found.map(({ formKey }) => formKey), cut, reporter.shownFailures.map(({ message }) => message)]).toEqual([formKeys, isIncomplete, messages]);
  });
});

describe('Go to Symbol in Workspace opens the copy the user picks (symbols.md, The features, story 4)', () => {
  it('at its own record\'s FormKey member, a child record\'s in its owner\'s file', async () => {
    const PLACED = '000901:A.esp';
    const cell = `{ "FormKey": "${GUN}", "Placed": [{ "FormKey": "${PLACED}" }] }`;
    const { symbolsFor, locate } = symbols(
      [plugin(modA)], [summary(PLACED, modA, 'PlacedGun')],
      { [key(GUN, modA)]: { file: GUN_FILE, text: cell }, [key(PLACED, modA)]: { file: GUN_FILE, text: cell } },
    );
    const [placed] = await symbolsFor('Placed');

    const found = placed && await locate(placed);

    expect(found && [`${found.uri.scheme}:${found.uri.path}`, cell.slice(found.start, found.end)])
      .toEqual([`modbench-child-record:${GUN_FILE}`, `"FormKey": "${PLACED}"`]);
  });

  it.each([
    ['its document states no member for it', { [key(GUN, modA)]: { file: GUN_FILE, text: '{}' } }, `${GUN_FILE} states no ${GUN} member.`],
    ['its plugin holds no copy of it', {}, `A.esp (ModA) holds no ${GUN}.`],
  ])('nowhere, and writes why, where %s', async (_case, files, detail) => {
    const { reporter, symbolsFor, locate } = symbols([plugin(modA)], [summary(GUN, modA, 'RustyGun')], files);

    expect(await Promise.all((await symbolsFor('Rusty')).map(locate))).toEqual([undefined]);
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: `Go to Symbol in Workspace cannot open RustyGun [${GUN}].`, detail }]);
  });

  it('nowhere, and writes why, where its document cannot be opened', async () => {
    const { reporter, symbolsFor, locate } = symbols([plugin(modA)], [summary(GUN, modA, 'RustyGun')], { [key(GUN, modA)]: { rendered: 'Gun.json' } });

    expect(await Promise.all((await symbolsFor('Rusty')).map(locate))).toEqual([undefined]);
    expect(reporter.shownFailures).toEqual([
      { severity: 'error', message: `Go to Symbol in Workspace cannot open RustyGun [${GUN}].`, detail: 'The file is gone.' },
    ]);
  });
});
