import { describe, it, expect, vi } from 'vitest';
import { UriWith } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri: UriWith }));

import type * as vscode from 'vscode';
import { workspaceSymbolsOf } from '../workspaceSymbols';
import type { PluginMetadata, RecordSummary } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { copyDocumentsOf, copyKey as key, type CopyOnDisk } from './copyDocuments';

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
    searchRecords: vi.fn((_query: string, _types: string[], scope?: typeof modA) => {
      const items = found.filter((row) => row.plugin === scope?.name && row.origin === scope.origin);
      return Promise.resolve({ items, total: items.length });
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
  const workspace = workspaceSymbolsOf({ client, reporter, open });
  return { client, reporter, ...workspace };
}

const listed = (found: Awaited<ReturnType<ReturnType<typeof symbols>['symbolsFor']>>) =>
  found.map(({ name, plugin: { name: pluginName }, uri }) => ({ name, plugin: pluginName, uri: `${uri.scheme}:${uri.path}` }));

describe('Go to Symbol in Workspace (plugin-source.md, In the text editor, story 4)', () => {
  it('lists each compiled plugin\'s copy of a record it finds, named by its EditorID and FormKey, at the copy\'s document', async () => {
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

  it('lists the copies of every compiled plugin, active or not, and none of a plugin that is not compiled (ADR-0012)', async () => {
    const notCompiled = { name: 'A.esp', origin: 'ModC' };
    const inactive = { name: 'D.esp', origin: 'ModD' };
    const INACTIVE_FILE = '/source/ModD/plugin-source/D.esp/Gun.json';
    const { symbolsFor } = symbols(
      [plugin(notCompiled, { isCompiledPlugin: false }), plugin(modA), plugin(inactive, { inLoadOrder: false })],
      [summary(GUN, notCompiled, 'RustyGun'), summary(GUN, modA, 'RustyGun'), summary(GUN, inactive, 'RustyGun')],
      {
        [key(GUN, notCompiled)]: { file: '/source/ModC/plugin-source/A.esp/Gun.json', text: '' },
        [key(GUN, modA)]: { file: GUN_FILE, text: '' },
        [key(GUN, inactive)]: { file: INACTIVE_FILE, text: '' },
      },
    );

    expect(listed(await symbolsFor('Rusty'))).toEqual([
      { name: `RustyGun [${GUN}]`, plugin: 'A.esp', uri: `file:${GUN_FILE}` },
      { name: `RustyGun [${GUN}]`, plugin: 'D.esp', uri: `file:${INACTIVE_FILE}` },
    ]);
  });

  it('lists nothing for an empty query, without asking mEdit', async () => {
    const { client, symbolsFor } = symbols([plugin(modA)], [summary(GUN, modA, 'RustyGun')], {});

    expect(await symbolsFor(' ')).toEqual([]);
    expect(client.searchRecords).not.toHaveBeenCalled();
  });

  it('lists what it found and writes a line for each plugin it could not search and each copy it could not open', async () => {
    const broken = { name: 'E.esp', origin: 'ModE' };
    const { reporter, symbolsFor } = symbols(
      [plugin(modA), plugin(modB), plugin(broken)],
      [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)],
      { [key(GUN, modA)]: { file: GUN_FILE, text: '' } },
      { searchRecords: (_query, _types, scope) => scope?.name === broken.name
        ? Promise.reject(new Error('mEdit is down.'))
        : Promise.resolve({ items: [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)].filter((row) => row.plugin === scope?.name), total: 1 }) },
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

    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['A.esp (ModA): mEdit is down.', 'A.esp (ModA): mEdit is down.']);
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
