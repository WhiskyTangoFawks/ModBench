import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { document, host, Location, Position, Range, Uri } from './vscodeHost';
import { instanceHolding, rowsOf, symbolsOver } from './symbolsOver';
import { mEditNames, spelledName } from './mEditNames';
import type { DocumentName } from '../../client';
import type { EntryNames, SymbolOwner } from '../../symbolNames/symbolNames';
import { FileConflictLookup, type CopyAt, type StackedFile } from '../../instanceLoader/fileConflictIndex';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { pluginMetadataFixture } from '../../client/test/fixtures';

const FILE = '/instance/source/Mod/plugin-source/Mod.esp/Npc.json';
const TEXT = '{ "Model": "Actors\\\\Npc.nif" }';
const AT = `${TEXT.slice(0, 14)}|${TEXT.slice(14)}`;
const SPELLED = 'Actors\\\\Npc.nif';
const PATH = 'meshes/actors/npc.nif';
const NAMED_FILE: DocumentName = { kind: 'File', start: 12, end: 26, value: 'Actors\\Npc.nif', dataPath: PATH };
const OWN = new Location(Uri.file(FILE), new Range(0, 12, 0, 26));
const LOOSE: CopyAt = { kind: 'loose', path: '/mods/Mod/meshes/actors/npc.nif' };
const ARCHIVED: CopyAt = { kind: 'archived', gameRelease: 'Fallout4', archive: '/mods/Mod/Mod - Main.ba2', file: PATH };
const NO_COPY = { none: `No enabled mod holds ${PATH}.` };

function naming(named: readonly DocumentName[], { copy = LOOSE as CopyAt | { none: string }, ...over }: { copy?: CopyAt | { none: string } } & Parameters<typeof symbolsOver>[0] = {}) {
  const reveal = vi.fn((_copy: CopyAt) => Promise.resolve());
  const made = symbolsOver({ names: mEditNames(() => named), fileCopies: { copyOf: () => copy, reveal }, ...over });
  return { ...made, reveal };
}

describe('each language feature asks the symbol under the place, of whatever kind (symbols.md, The features)', () => {
  it('asks a plugin\'s name inside a FormKey of the plugin, not the record', async () => {
    const text = '{ "Race": "000801:Base.esm" }';
    const owner: SymbolOwner = { read: () => Promise.resolve({ references: [], leftOut: [] }), nameAt: () => Promise.resolve({ name: 'Base.esm' }), plan: () => Promise.reject(new Error('Not planned here.')) };
    naming([spelledName('Record', text, '"000801:Base.esm"', { value: '000801:Base.esm', record: '000801:Base.esm' })], {
      owners: [owner], pluginsShown: { tooltipLines: () => ['the plugin'] },
      instance: instanceHolding(instanceValueFixture({ plugins: [{ name: 'Base.esm', origin: 'Base Mod', path: '/data/Base.esm', line: 0, enabled: true, winning: true }] })),
    });

    expect((await host.hover(FILE, text.replace('Base.esm"', 'Ba|se.esm"')))?.text).toBe('the plugin');
  });

  it('answers nothing where no kind names the place', async () => {
    naming([]);

    expect([await host.definition(FILE, AT), await host.references(FILE, AT), await host.hover(FILE, AT), await host.complete(FILE, AT)]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('Go to Definition presents the symbol\'s definition (symbols.md, The symbols)', () => {
  it('opens a place there', async () => {
    const GUN = '000801:A.esp';
    const gunText = `{ "FormKey": "${GUN}" }`;
    naming([spelledName('Declaration', gunText, `"FormKey": "${GUN}"`, { record: GUN }), spelledName('Record', gunText, `"${GUN}"`, { value: GUN, record: GUN, fieldPath: 'FormKey' })], {
      arrange: (client) => {
        client.setQueryAnswer('getRecordOwners', [{ name: 'A.esp', origin: 'ModA' }]);
        client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: '/source/ModA/Gun.json' });
        host.holds([document('/source/ModA/Gun.json', gunText)]);
      },
    });

    expect(await host.definition(FILE, gunText.replace(`"${GUN}"`, '"0008|01:A.esp"'))).toEqual(new Location(Uri.file('/source/ModA/Gun.json'), new Range(0, 2, 0, 2 + `"FormKey": "${GUN}"`.length)));
  });

  it('opens a file at its start', async () => {
    const text = '{ "Name": "Quest" }';
    naming([spelledName('Script', text, 'Quest')], {
      copy: { kind: 'loose', path: '/scripts/Quest.psc' },
      instance: instanceHolding(instanceValueFixture({ papyrusScripts: [{ name: 'Quest', sourceDataPath: 'Scripts/Source/User/Quest.psc', compiledDataPath: 'Scripts/Quest.pex' }] })),
    });

    expect(await host.definition(FILE, text.replace('Quest"', 'Qu|est"'))).toEqual(new Location(Uri.file('/scripts/Quest.psc'), new Position(0, 0)));
  });

  it('selects a row, leaving the editor at the name asked about', async () => {
    const show = vi.fn(() => Promise.resolve());
    const owner: SymbolOwner = { read: () => Promise.resolve({ references: [], leftOut: [] }), nameAt: () => Promise.resolve({ name: 'Base.esm' }), plan: () => Promise.reject(new Error('Not planned here.')) };
    naming([], {
      owners: [owner], rows: rowsOf({ plugins: { show: () => show } }),
      instance: instanceHolding(instanceValueFixture({ plugins: [{ name: 'Base.esm', origin: 'Base Mod', path: '/data/Base.esm', line: 0, enabled: true, winning: true }] })),
    });

    expect(await host.definition(FILE, '*Ba|se.esm')).toEqual(new Location(Uri.file(FILE), new Range(0, 1, 0, 9)));
    expect(show).toHaveBeenCalledOnce();
  });

  it.each([['loose', LOOSE], ['archived', ARCHIVED]])('shows a copy in the Explorer, inside its archive when archived, leaving the editor at the name asked about (%s)', async (_case, copy) => {
    const { reveal } = naming([NAMED_FILE], { copy });

    expect(await host.definition(FILE, AT)).toEqual(OWN);
    expect(reveal.mock.calls).toEqual([[copy]]);
  });

  it('says in the Output why it cannot go, and goes nowhere', async () => {
    const { reporter } = naming([NAMED_FILE], { copy: NO_COPY });

    expect(await host.definition(FILE, AT)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: `Go to Definition cannot go to ${PATH}.`, detail: NO_COPY.none }]);
  });

  it('writes the reason again each time it recurs (common.md, Reporting: a line in the Output for each reason)', async () => {
    const { reporter } = naming([NAMED_FILE], { copy: NO_COPY });

    await host.definition(FILE, AT);
    await host.definition(FILE, AT);

    expect(reporter.shownFailures).toHaveLength(2);
  });

  it('says why a name that names nothing has no definition', async () => {
    const { reporter } = naming([{ ...NAMED_FILE, dataPath: null, refusal: 'no path its asset type holds' }]);

    expect(await host.definition(FILE, AT)).toBeUndefined();
    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['no path its asset type holds']);
  });

  it('goes nowhere, and says nothing, for a kind with no definition', async () => {
    const entries: EntryNames = { listed: () => Promise.resolve([]), read: () => Promise.resolve({ references: [], leftOut: [] }), nameAt: () => Promise.resolve({ entry: { kind: 'profile', name: 'Default' }, start: 1, end: 8 }) };
    const { reporter } = naming([], { entryOwners: [entries] });

    expect([await host.definition(FILE, 'D|efault'), reporter.shownFailures]).toEqual([undefined, []]);
  });

  it('says why the Explorer could not show the copy', async () => {
    const { reveal, reporter } = naming([NAMED_FILE]);
    reveal.mockRejectedValueOnce(new Error('The Explorer is gone.'));

    expect(await host.definition(FILE, AT)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: `Go to Definition cannot show ${PATH}.`, detail: 'The Explorer is gone.' }]);
  });
});

describe('Find All References lists the places the symbol\'s kind answers (symbols.md, The features, story 2)', () => {
  const PLACED = { start: { line: 0, character: 12 }, end: { line: 0, character: 26 } };
  const listing = (leftOut: string[], copies = [{ formKey: '000801:Mod.esp', plugin: { name: 'Mod.esp', origin: 'Mod' }, document: { kind: 'OwnFile' as const, location: FILE }, ranges: [PLACED] }]) =>
    naming([NAMED_FILE], { arrange: (client) => { client.setQueryAnswer('getPlacedFileReferences', { copies, leftOut }); } });

  it('writes a line in the Output for each file it could not read, and no notification, a VS Code feature that answers in part (common.md, Reporting)', async () => {
    const { reporter } = listing(['/a: unreadable', '/b: unreadable']);

    expect(await host.references(FILE, AT)).toEqual([OWN]);
    expect([reporter.reports, reporter.shownFailures.map(({ severity, message, detail }) => [severity, message, detail])]).toEqual([[], [
      ['warning', `Find All References on ${PATH} could not read a file that may name it.`, '/a: unreadable'],
      ['warning', `Find All References on ${PATH} could not read a file that may name it.`, '/b: unreadable'],
    ]]);
  });

  it('says in the Output why it cannot list what names a symbol, and lists nothing', async () => {
    const GUN = '000801:A.esp';
    const text = `{ "Race": "${GUN}" }`;
    const { reporter } = naming([spelledName('Record', text, `"${GUN}"`, { value: GUN, record: GUN })], {
      arrange: (client) => { client.setQueryFailure('getPlacedReferences', { failed: 'refused', refusal: 'The record index is still reading.' }); },
    });

    expect(await host.references(FILE, text.replace(`"${GUN}"`, '"0008|01:A.esp"'))).toEqual([]);
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: `Find All References cannot list what names ${GUN}.`, detail: `mEdit cannot list what references ${GUN}: The record index is still reading.` }]);
  });

  it('writes a line for each file left out, each time it is asked', async () => {
    const { reporter } = listing(['/a: unreadable', '/b: unreadable'], []);

    await host.references(FILE, AT);
    await host.references(FILE, AT);

    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['/a: unreadable', '/b: unreadable', '/a: unreadable', '/b: unreadable']);
  });
});

describe('completion offers the symbols of the kind a file names at the place (symbols.md, The features, story 5)', () => {
  it.each([[false], [true]])('tells each kind it asks the gesture, and whether VS Code has cancelled it (cancelled: %s)', async (cancelled) => {
    const field = '{ "Armor": "Rusty" }';
    const { client } = naming([{ kind: 'Reference', start: 12, end: 17, value: 'Rusty', validFormKeyTypes: ['ARMO'] }], {
      arrange: (held) => { held.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'A.esp', origin: 'ModA', path: '/mods/ModA/A.esp' })]); },
    });

    await host.complete(FILE, `${field.slice(0, 17)}|${field.slice(17)}`, { isCancellationRequested: cancelled });

    expect(client.calls.filter(({ method }) => method === 'searchRecords')).toHaveLength(cancelled ? 0 : 1);
  });
});

describe('Go to Symbol in Workspace lists every kind\'s symbols (symbols.md, The features, story 4)', () => {
  it('lists each kind\'s symbols whose name holds the query, the kinds in order', async () => {
    const stackedCopies = new FileConflictLookup<StackedFile>();
    stackedCopies.set({ relativePath: 'meshes/gun.nif', copies: [] });
    naming([], {
      copy: LOOSE,
      instance: instanceHolding(instanceValueFixture({ stackedCopies, plugins: [{ name: 'Gun.esp', origin: 'Gun Mod', path: '/data/Gun.esp', line: 0, enabled: true, winning: true }] })),
      arrange: (client) => {
        client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name: 'A.esp', origin: 'ModA', path: '/mods/ModA/A.esp', isCompiledPlugin: true })]);
        client.setQueryAnswer('searchRecords', { items: [{ formKey: '000801:A.esp', plugin: 'A.esp', origin: 'ModA', editorId: 'Gun', loadOrderIndex: 0, isWinner: true, workingTreeState: 'None', hasContainerChildren: false, hasParseFailure: false }], total: 1 });
      },
    });

    expect((await host.workspaceSymbols(' gun ')).map(({ name }) => name)).toEqual(['Gun.esp', 'meshes/gun.nif', 'Gun [000801:A.esp]']);
  });

  it('lists nothing for an empty query, asking no kind', async () => {
    const { client } = naming([]);

    expect([await host.workspaceSymbols('  '), client.calls.filter(({ method }) => method === 'getPlugins' || method === 'searchRecords')]).toEqual([[], []]);
  });
});
