import { describe, it, expect, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri }));

import type * as vscode from 'vscode';
import { workspaceSymbolsOf, type RecordSymbol } from '../workspaceSymbols';
import type { PluginMetadata, RecordSummary } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { copyDocumentsOf, copyKey as key, type CopyOnDisk } from './copyDocuments';
import { spelledIn } from './fakeSourceNames';

const modA = { name: 'A.esp', origin: 'ModA' };
const modB = { name: 'B.esp', origin: 'ModB' };
const GUN = '000900:A.esp';
const STAND = '000700:Fallout4.esm';
const GUN_FILE = '/source/ModA/plugin-source/A.esp/Gun.json';
const STAND_FILE = '/source/ModB/plugin-source/B.esp/Stand.json';

const plugin = (address: typeof modA, over: Partial<PluginMetadata> = {}): PluginMetadata => ({
  ...address, path: `/mods/${address.origin}/${address.name}`, isLight: false, isMaster: false, isBlueprint: false, masters: [],
  isImmutable: false, inLoadOrder: true, hasMatchingRecords: true, isCompiledPlugin: true, hasParseFailure: false, pluginSourceUnreadable: null, ...over,
});

const summary = (formKey: string, address: typeof modA, editorId?: string): RecordSummary => ({
  formKey, plugin: address.name, origin: address.origin, editorId, loadOrderIndex: 0, isWinner: true,
  workingTreeState: 'None', hasContainerChildren: false, hasParseFailure: false,
});

type Client = Parameters<typeof workspaceSymbolsOf<{ getText(): string }>>[0]['client'];

function symbols(plugins: PluginMetadata[], found: RecordSummary[], files: Record<string, CopyOnDisk>, answering: Partial<Client> = {}) {
  const { getCopyDocument, textOnFile } = copyDocumentsOf(files);
  const client: Client = {
    getPlugins: () => Promise.resolve(plugins),
    searchRecords: vi.fn((_query: string, _types: string[], scope?: typeof modA, atMost?: number) => {
      const searched = scope ? [scope] : plugins.filter((each) => each.inLoadOrder);
      const items = found.filter((row) => searched.some((each) => row.plugin === each.name && row.origin === each.origin));
      return Promise.resolve({ items: items.slice(0, atMost ?? 20), total: items.length });
    }),
    getRecordOwner: () => Promise.reject(new Error('A symbol names its plugin.')),
    getCopyDocument,
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
    client, reporter,
    symbolsFor: (query: string) => workspace.symbolsFor(query, 'Go to Symbol in Workspace'),
    compiledCopiesOf: (formKey: string) => workspace.compiledCopiesOf(formKey, 'Referenced By'),
    locate: (symbol: RecordSymbol) => workspace.locate(symbol, 'Go to Symbol in Workspace'),
  };
}

const listed = (found: Awaited<ReturnType<ReturnType<typeof symbols>['symbolsFor']>>) =>
  found.map(({ name, plugin: { name: pluginName }, uri }) => ({ name, plugin: pluginName, uri: `${uri.scheme}:${uri.path}` }));

describe('Go to Symbol in Workspace (symbols.md, The features, story 4)', () => {
  it('lists each copy of a record it finds, named by its EditorID and FormKey, at the copy\'s document', async () => {
    const { symbolsFor } = symbols(
      [plugin(modA), plugin(modB)],
      [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)],
      { [key(GUN, modA)]: { file: GUN_FILE, text: '' }, [key(STAND, modB)]: { file: STAND_FILE, text: '' } },
    );

    expect(listed(await symbolsFor('Rusty'))).toEqual([
      { name: `RustyGun [${GUN}]`, plugin: 'A.esp', uri: `file:${GUN_FILE}` },
      { name: STAND, plugin: 'B.esp', uri: `file:${STAND_FILE}` },
    ]);
  });

  it('lists the copies of every active plugin and every compiled plugin, and none of a plugin that is neither (ADR-0012)', async () => {
    const vanilla = { name: 'Fallout4.esm', origin: 'Fallout4.esm' };
    const inactive = { name: 'D.esp', origin: 'ModD' };
    const neither = { name: 'F.esp', origin: 'ModF' };
    const INACTIVE_FILE = '/source/ModD/plugin-source/D.esp/Gun.json';
    const { symbolsFor } = symbols(
      [plugin(vanilla, { isCompiledPlugin: false }), plugin(modA), plugin(inactive, { inLoadOrder: false }), plugin(neither, { inLoadOrder: false, isCompiledPlugin: false })],
      [summary(GUN, vanilla, 'RustyGun'), summary(GUN, modA, 'RustyGun'), summary(GUN, inactive, 'RustyGun'), summary(GUN, neither, 'RustyGun')],
      {
        [key(GUN, vanilla)]: { rendered: 'Gun.json' },
        [key(GUN, modA)]: { file: GUN_FILE, text: '' },
        [key(GUN, inactive)]: { file: INACTIVE_FILE, text: '' },
        [key(GUN, neither)]: { file: '/source/ModF/plugin-source/F.esp/Gun.json', text: '' },
      },
    );

    expect(listed(await symbolsFor('Rusty')).map(({ plugin }) => plugin)).toEqual(['Fallout4.esm', 'A.esp', 'D.esp']);
  });

  it('searches the active plugins in one ask, and each compiled plugin outside them alone', async () => {
    const inactive = plugin({ name: 'D.esp', origin: 'ModD' }, { inLoadOrder: false });
    const { client, symbolsFor } = symbols([plugin(modA), plugin(modB), inactive], [], {});

    await symbolsFor('Rusty');

    expect(vi.mocked(client.searchRecords).mock.calls.map(([query, types, scope]) => [query, types, scope])).toEqual([['Rusty', [], undefined], ['Rusty', [], inactive]]);
  });

  it('lists at most 200 copies a search, and says how many of how many match', async () => {
    const guns = Array.from({ length: 201 }, (_, index) => summary(`${(0x900 + index).toString(16).padStart(6, '0').toUpperCase()}:A.esp`, modA, `Gun${index}`));
    const files = Object.fromEntries(guns.map(({ formKey }) => [key(formKey, modA), { file: `/source/ModA/plugin-source/A.esp/${formKey}.json`, text: '' }]));
    const { reporter, symbolsFor } = symbols([plugin(modA)], guns, files);

    expect([(await symbolsFor('Gun')).length, reporter.shownFailures.map(({ message }) => message)])
      .toEqual([200, ['Go to Symbol in Workspace lists 200 of the 201 copies of records whose EditorID or FormKey holds "Gun".']]);
  });

  it.each([
    ['an EditorID', 'Rusty', 'Type more of the EditorID or FormKey to narrow the list.'],
    ['a whole FormKey, which typing more cannot narrow', GUN.toLowerCase(), undefined],
  ])('when it lists fewer than match for %s, says what typing more does', async (_case, query, detail) => {
    const { reporter, symbolsFor } = symbols([plugin(modA)], [], { [key(GUN, modA)]: { file: GUN_FILE, text: '' } }, {
      searchRecords: () => Promise.resolve({ items: [summary(GUN, modA, 'RustyGun')], total: 31 }),
    });

    await symbolsFor(query);

    expect(reporter.shownFailures.map((shown) => shown.detail)).toEqual([detail]);
  });

  it('finds a record\'s copies for Referenced By in the compiled plugins outside the load order alone', async () => {
    const inactive = { name: 'D.esp', origin: 'ModD' };
    const INACTIVE_FILE = '/source/ModD/plugin-source/D.esp/Gun.json';
    const { compiledCopiesOf } = symbols(
      [plugin(modA), plugin(inactive, { inLoadOrder: false })],
      [summary(GUN, modA, 'RustyGun'), summary(GUN, inactive, 'RustyGun')],
      { [key(GUN, modA)]: { file: GUN_FILE, text: '' }, [key(GUN, inactive)]: { file: INACTIVE_FILE, text: '' } },
    );

    expect(listed(await compiledCopiesOf(GUN))).toEqual([{ name: `RustyGun [${GUN}]`, plugin: 'D.esp', uri: `file:${INACTIVE_FILE}` }]);
  });

  it('lists what it found and writes a line for each search that failed and each copy it could not open', async () => {
    const broken = { name: 'E.esp', origin: 'ModE' };
    const { reporter, symbolsFor } = symbols(
      [plugin(modA), plugin(modB), plugin(broken, { inLoadOrder: false })],
      [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)],
      { [key(GUN, modA)]: { file: GUN_FILE, text: '' } },
      { searchRecords: (_query, _types, scope) => scope === undefined
        ? Promise.resolve({ items: [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)], total: 2 })
        : Promise.reject(new Error('mEdit is down.')) },
    );

    expect(listed(await symbolsFor('Rusty'))).toEqual([{ name: `RustyGun [${GUN}]`, plugin: 'A.esp', uri: `file:${GUN_FILE}` }]);
    const message = 'Go to Symbol in Workspace left out what it could not search or open.';
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message, detail: 'E.esp (ModE): mEdit is down.' },
      { severity: 'warning', message, detail: `B.esp (ModB) holds no ${STAND}.` },
    ]);
  });

  it('writes a reason again each time a search meets it', async () => {
    const { reporter, symbolsFor } = symbols([plugin(modA)], [], {}, { searchRecords: () => Promise.reject(new Error('mEdit is down.')) });

    await symbolsFor('Rus');
    await symbolsFor('Rusty');

    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['The active plugins: mEdit is down.', 'The active plugins: mEdit is down.']);
  });

  it('opens a symbol at its own record\'s FormKey member, a child record\'s in its owner\'s file', async () => {
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

  it('locates nothing for a symbol whose document it cannot open, and writes why', async () => {
    const files = { [key(GUN, modA)]: { file: GUN_FILE, text: '' } };
    const { reporter, symbolsFor, locate } = symbols([plugin(modA)], [summary(GUN, modA, 'RustyGun')], files);
    const listing = await symbolsFor('Rusty');
    files[key(GUN, modA)] = { file: '/elsewhere.json', text: '' };

    expect(await Promise.all(listing.map(locate))).toEqual([undefined]);
    expect(reporter.shownFailures).toEqual([
      { severity: 'error', message: `Go to Symbol in Workspace cannot open RustyGun [${GUN}].`, detail: 'The file is gone.' },
    ]);
  });

  it('locates nothing, and writes why, for a symbol whose document states no member for it', async () => {
    const { reporter, symbolsFor, locate } = symbols([plugin(modA)], [summary(GUN, modA, 'RustyGun')], { [key(GUN, modA)]: { file: GUN_FILE, text: '{}' } });

    expect(await Promise.all((await symbolsFor('Rusty')).map(locate))).toEqual([undefined]);
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: `Go to Symbol in Workspace cannot open RustyGun [${GUN}].`, detail: `${GUN_FILE} states no ${GUN} member.` },
    ]);
  });

  it('lists nothing, and writes why, when it cannot list the plugins', async () => {
    const { reporter, symbolsFor } = symbols([], [], {}, { getPlugins: () => Promise.reject(new Error('mEdit is down.')) });

    expect(await symbolsFor('Rusty')).toEqual([]);
    expect(reporter.shownFailures).toEqual([
      { severity: 'error', message: 'Go to Symbol in Workspace cannot list the compiled plugins.', detail: 'mEdit is down.' },
    ]);
  });
});
