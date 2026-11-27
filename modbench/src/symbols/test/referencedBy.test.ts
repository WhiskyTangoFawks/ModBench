import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { document, host, Uri } from './vscodeHost';
import { instanceHolding, rowsOf, symbolsOver } from './symbolsOver';
import { mEditNames, spelledName } from './mEditNames';
import type { EntryNames, PlaceInFile, SymbolOwner } from '../../symbolNames/symbolNames';
import type { OriginFile } from '../../instanceLoader/instance';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled as until } from '../../test/eventually';
import { pluginMetadataFixture } from '../../client/test/fixtures';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const GUN = '000801:Base.esm';
const GUN_FILE = '/source/Base Mod/plugin-source/Base.esm/Gun.json';
const GUN_TEXT = `{ "FormKey": "${GUN}" }`;
const mod = { argument: { kind: 'mod', name: 'Base Mod' } };
const separator = { kind: 'separator', separator: { kind: 'separator', name: 'Gear', enabled: true } };
const downloadedFile = { argument: { kind: 'downloadedFile', row: downloadedFileRowFixture('Patch-1.7z') } };
const pluginRow = { argument: { kind: 'plugin', plugin: BASE } };
const recordRow = { argument: { kind: 'record', formKey: GUN } };
const fileRow = { a: 'file row' };
const WALL: OriginFile = { relativePath: 'meshes/architecture/wall.nif', path: '/instance/mods/Walls/meshes/architecture/wall.nif', sourcePath: '/instance/mods/Walls/meshes/architecture/wall.nif', excluded: false, markedExcluded: false, includedPath: 'meshes/architecture/wall.nif' };
const GAME_WALL = { relativePath: 'meshes/architecture/gamewall.nif', path: '/game/Data/meshes/architecture/gamewall.nif' };
const PLACE: PlaceInFile = { file: '/profiles/Default/modlist.txt', start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

interface Options {
  selection?: readonly unknown[];
  focusedRecord?: string;
}

function setup({ selection = [], focusedRecord }: Options = {}) {
  const entries: EntryNames = { listed: () => Promise.resolve([]), read: () => Promise.resolve({ references: [PLACE], leftOut: [] }), nameAt: () => Promise.resolve(undefined) };
  const plugins: SymbolOwner = { read: () => Promise.resolve({ references: [{ place: PLACE, names: BASE }], leftOut: [] }), nameAt: () => Promise.resolve(undefined), plan: () => Promise.reject(new Error('Not planned here.')) };
  const made = symbolsOver({
    instance: instanceHolding(instanceValueFixture({
      mods: [{ kind: 'mod', name: 'Base Mod', enabled: true }, { kind: 'separator', name: 'Gear', enabled: true }],
      downloadedFiles: { kind: 'listed', rows: [downloadedFileRowFixture('Patch-1.7z')] },
      plugins: [{ ...BASE, path: '/data/Base.esm', line: 0, enabled: true, winning: true }],
    })),
    entryOwners: [entries], owners: [plugins], focusedRecord: () => focusedRecord,
    names: mEditNames((text) => (text === GUN_TEXT ? [spelledName('Record', GUN_TEXT, `"${GUN}"`, { record: GUN, fieldPath: 'FormKey', value: GUN })] : [])),
    rows: rowsOf({
      selection: () => selection, mods: { dataPathOf: (row) => (row === fileRow ? 'meshes/a.nif' : undefined) },
      filesHeld: () => ({ filesByMod: new Map([['Walls', [WALL]]]), dataFolderFiles: { kind: 'listed', files: new Map([[GAME_WALL.relativePath, GAME_WALL]]) } }),
    }),
    arrange: (client) => {
      client.setQueryAnswer('getPlacedFileReferences', { copies: [{ formKey: GUN, plugin: BASE, document: { kind: 'OwnFile', location: GUN_FILE }, ranges: [PLACE] }], leftOut: [] });
      client.setQueryAnswer('getRecordOwners', [BASE]);
      client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: GUN_FILE });
      client.setQueryAnswer('getComparison', null);
      host.holds([document(GUN_FILE, GUN_TEXT)]);
    },
  });
  const listed = () => host.referencesShown.map(({ title }) => title);
  return { ...made, listed, run: (row?: unknown) => host.run('modbench.symbol.referencedBy', row) };
}

const pickedIn = async (typed: string, label: string) => {
  const [pick] = host.quickPicks;
  pick?.type(typed);
  await until(() => { expect(pick?.qp.items.map((item) => item.label)).toContain(label); });
  const item = pick?.qp.items.find((each) => each.label === label);
  if (item) pick?.accept(item);
};

describe('referenced by lists where files name the symbol a row stands for (commands.md, `referenced by` under Symbol)', () => {
  it.each<[string, unknown, string]>([
    ['a mod row', mod, 'Base Mod'],
    ['a separator row', separator, 'Gear'],
    ['a downloaded file row', downloadedFile, 'Patch-1.7z'],
    ['a plugin row', pluginRow, 'Base.esm (Base Mod)'],
    ['a record row', recordRow, GUN],
    ['a file row', fileRow, 'meshes/a.nif'],
  ])('asks for the symbol of %s', async (_what, row, subject) => {
    const { listed, run } = setup();

    await run(row);

    expect(listed()).toEqual([`Referenced By: ${subject}`]);
  });

  it('asks for the one selected row when none is given, without asking for a symbol', async () => {
    const { listed, run } = setup({ selection: [pluginRow] });

    await run();

    expect([listed(), host.quickPicks]).toEqual([['Referenced By: Base.esm (Base Mod)'], []]);
  });

  it('opens the pick when several rows are selected, and asks about the symbol picked', async () => {
    const { listed, run } = setup({ selection: [pluginRow, mod] });

    const running = run();
    await pickedIn('Gea', 'Gear');
    await running;

    expect(listed()).toEqual(['Referenced By: Gear']);
  });

  it('refuses a row that stands for no symbol, saying why', async () => {
    const { listed, reporter, run } = setup();

    await run({ a: 'row of no symbol' });

    expect([listed(), reporter.reports.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['error', 'It is not a symbol.']]]);
  });
});

describe('referenced by on a file the Explorer shows', () => {
  it('asks for the file, in a mod or the game\'s Data folder, by its path in the Data folder', async () => {
    const { listed, run } = setup();

    await run(Uri.file(WALL.path));
    await run(Uri.file(GAME_WALL.path));

    expect(listed()).toEqual([`Referenced By: ${WALL.relativePath}`, `Referenced By: ${GAME_WALL.relativePath}`]);
  });

  it('refuses a file in no mod and outside the game\'s Data folder', async () => {
    const { listed, reporter, run } = setup();

    await run(Uri.file('/instance/profiles/Default/modlist.txt'));

    expect([listed(), reporter.reports.map(({ severity }) => severity)]).toEqual([[], ['error']]);
  });
});

describe('referenced by from the palette, with nothing given or selected', () => {
  it('asks about the record tab in focus, without asking for a symbol', async () => {
    const { listed, run } = setup({ focusedRecord: GUN });

    await run();

    expect([listed(), host.quickPicks]).toEqual([[`Referenced By: ${GUN}`], []]);
  });

  it('asks about the symbol the user picks', async () => {
    const { listed, run } = setup();

    const running = run();
    await pickedIn('Base', 'Base Mod');
    await running;

    expect(listed()).toEqual(['Referenced By: Base Mod']);
  });

  it('asks about nothing when the user picks nothing', async () => {
    const { listed, run } = setup();

    const running = run();
    host.quickPicks[0]?.escape();
    await running;

    expect(listed()).toEqual([]);
  });
});

describe('pick a symbol as Go to Symbol in Workspace finds it', () => {
  const RECORD_FOUND = { formKey: GUN, plugin: BASE.name, origin: BASE.origin, editorId: 'Gun', loadOrderIndex: 0, isWinner: true, workingTreeState: 'None' as const, hasContainerChildren: false, hasParseFailure: false };
  const searching = () => {
    const made = setup();
    made.client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ ...BASE, path: '/data/Base.esm', isCompiledPlugin: true })]);
    made.client.setQueryAnswer('searchRecords', { items: [RECORD_FOUND], total: 1 });
    return made;
  };
  const searched = (made: ReturnType<typeof setup>) => made.client.calls.filter(({ method }) => method === 'searchRecords').map(({ args }) => args[0]);

  it('lists the symbols of every kind that hold what is typed, each kind told the gesture it picks for, and answers the one accepted', async () => {
    const made = searching();
    made.client.setQueryAnswerOnce('searchRecords', { failed: 'timed-out' });

    const running = made.run();
    host.quickPicks[0]?.type('Gu');
    await until(() => { expect(searched(made)).toEqual(['Gu']); });
    await pickedIn('Gun', `Gun [${GUN}]`);
    await running;

    expect([made.listed(), made.reporter.shownFailures.map(({ message }) => message)]).toEqual([[`Referenced By: ${GUN}`], ['Referenced By left out what it could not search or open.']]);
  });

  it('cancels the search of what was typed once more is typed', async () => {
    const made = searching();

    const running = made.run();
    host.quickPicks[0]?.type('g');
    await pickedIn('gu', `Gun [${GUN}]`);
    host.quickPicks[0]?.escape();
    await running;

    expect(searched(made)).toEqual(['gu']);
  });

  it('reports why the symbols could not be listed, and stops showing busy', async () => {
    const { reporter } = symbolsOver({
      instance: instanceHolding(instanceValueFixture({ papyrusScripts: [{ name: 'Gun', compiledDataPath: 'Scripts/Gun.pex' }] })),
      fileCopies: { copyOf: () => { throw new Error('the copies are unreadable'); }, reveal: () => Promise.resolve() },
    });

    void host.run('modbench.symbol.referencedBy');
    const [pick] = host.quickPicks;
    pick?.type('gun');

    await until(() => { expect(reporter.reports.map(({ severity, detail }) => [severity, detail])).toEqual([['error', 'the copies are unreadable']]); });
    expect(pick?.qp.busy).toBe(false);
  });
});
