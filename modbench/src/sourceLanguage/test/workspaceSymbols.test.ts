import { describe, it, expect, vi } from 'vitest';
import { uriFrom } from '../../test/vscodeMock';

interface TestUri { scheme: string; path: string; query: string; with(change: Partial<Pick<TestUri, 'scheme' | 'query'>>): TestUri }

const h = vi.hoisted(() => {
  const uri = (scheme: string, path: string, query = ''): TestUri =>
    ({ scheme, path, query, with: (change) => uri(change.scheme ?? scheme, path, change.query ?? query) });
  return { uri };
});

vi.mock('vscode', () => ({
  Uri: { from: uriFrom, file: (path: string) => h.uri('file', path) },
}));

import type * as vscode from 'vscode';
import { workspaceSymbolsOf } from '../workspaceSymbols';
import type { PluginMetadata, RecordSummary } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';

const modA = { name: 'A.esp', origin: 'ModA' };
const modB = { name: 'B.esp', origin: 'ModB' };
const GUN = '000900:A.esp';
const STAND = '000700:Fallout4.esm';
const GUN_FILE = '/mods/ModA/plugin-source/A.esp/Gun.json';
const STAND_FILE = '/mods/ModB/plugin-source/B.esp/Stand.json';

const plugin = (address: typeof modA, over: Partial<PluginMetadata> = {}): PluginMetadata => ({
  ...address, path: `/mods/${address.origin}/${address.name}`, isLight: false, isMaster: false, isBlueprint: false, masters: [],
  recordCount: 0, isImmutable: false, inLoadOrder: true, hasMatchingRecords: true, isTracked: true, hasParseFailure: false, pluginSourceUnreadable: false, ...over,
});

const summary = (formKey: string, address: typeof modA, editorId?: string): RecordSummary => ({
  formKey, plugin: address.name, origin: address.origin, editorId, loadOrderIndex: 0, isWinner: true,
  workingTreeState: 'None', hasContainerChildren: false, hasParseFailure: false,
});

type Client = Parameters<typeof workspaceSymbolsOf<{ getText(): string }>>[0]['client'];

function symbols(plugins: PluginMetadata[], found: RecordSummary[], files: Record<string, { file: string; text: string }>, answering: Partial<Client> = {}) {
  const client: Client = {
    getPlugins: () => Promise.resolve(plugins),
    searchRecords: vi.fn((_query: string, _types: string[], scope?: typeof modA) => {
      const items = found.filter((row) => row.plugin === scope?.name && row.origin === scope.origin);
      return Promise.resolve({ items, total: items.length });
    }),
    getRecordOwner: () => Promise.reject(new Error('A symbol names its plugin.')),
    getCopyDocument: (address, formKey) => {
      const copyKey = key(formKey, address);
      const copy = files[copyKey];
      const firstOnFile = Object.entries(files).find(([, other]) => other.file === copy?.file)?.[0];
      return Promise.resolve(copy ? { path: copy.file, isContainersDocument: firstOnFile !== copyKey } : null);
    },
    ...answering,
  };
  const open = (uri: vscode.Uri) => new Promise<{ getText(): string }>((resolve) => {
    const text = Object.values(files).find((copy) => copy.file === uri.path)?.text;
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
  it('lists each tracked plugin\'s copy of a record it finds, named by its EditorID and FormKey, at the copy\'s document', async () => {
    const { symbolsFor } = symbols(
      [plugin(modA), plugin(modB)],
      [summary(GUN, modA, 'RustyGun'), summary(STAND, modB)],
      { [key(GUN, modA)]: { file: GUN_FILE, text: '' }, [key(STAND, modB)]: { file: STAND_FILE, text: '' } },
    );

    expect(listed(await symbolsFor('Rusty'))).toEqual([
      { name: `RustyGun [${GUN}]`, plugin: 'A.esp', uri: `file:${GUN_FILE}` },
      { name: `[${STAND}]`, plugin: 'B.esp', uri: `file:${STAND_FILE}` },
    ]);
  });

  it('searches every tracked plugin, active or not (ADR-0012)', async () => {
    const untracked = { name: 'A.esp', origin: 'ModC' };
    const inactive = { name: 'D.esp', origin: 'ModD' };
    const { client, symbolsFor } = symbols(
      [plugin(untracked, { isTracked: false }), plugin(modA), plugin(inactive, { inLoadOrder: false })], [], {});

    await symbolsFor('Rusty');

    expect(vi.mocked(client.searchRecords).mock.calls.map(([, , scope]) => [scope?.name, scope?.origin])).toEqual([['A.esp', 'ModA'], ['D.esp', 'ModD']]);
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
      { severity: 'error', message: 'Go to Symbol in Workspace cannot list the tracked plugins.', detail: 'mEdit is down.' },
    ]);
  });
});

function key(formKey: string, { name, origin }: typeof modA): string {
  return `${formKey} ${name} ${origin}`;
}
