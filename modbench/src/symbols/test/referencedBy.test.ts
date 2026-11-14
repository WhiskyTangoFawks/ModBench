import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (clicked?: unknown) => Promise<void>>(),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (command: string, handler: (clicked?: unknown) => Promise<void>) => { handlers.set(command, handler); return { dispose: vi.fn() }; },
  },
  Uri, TreeItem, TreeItemCollapsibleState,
}));

import { registerReferencedBy, type FilesHeld } from '../referencedBy';
import type { OriginFile } from '../../instanceLoader/instance';
import { present } from '../../ports/present';
import { recordingReporter } from '../../test/surfacingDoubles';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import type { SymbolName } from '../symbolKind';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const GUN = '000801:Base.esm';
const mod = { argument: { kind: 'mod', name: 'Base Mod' } };
const separator = { kind: 'separator', separator: { kind: 'separator', name: 'Gear', enabled: true } };
const downloadedFile = { argument: { kind: 'downloadedFile', row: downloadedFileRowFixture('Patch-1.7z') } };
const pluginRow = { argument: { kind: 'plugin', plugin: BASE } };
const recordRow = { argument: { kind: 'record', formKey: GUN } };
const fileRow = { a: 'file row' };
const WALL: OriginFile = { relativePath: 'meshes/architecture/wall.nif', path: '/instance/mods/Walls/meshes/architecture/wall.nif', sourcePath: '/instance/mods/Walls/meshes/architecture/wall.nif', excluded: false, markedExcluded: false, includedPath: 'meshes/architecture/wall.nif' };
const GAME_WALL = { relativePath: 'meshes/architecture/gamewall.nif', path: '/game/Data/meshes/architecture/gamewall.nif' };
const HELD: FilesHeld = {
  filesByMod: new Map([['Walls', [WALL]]]),
  dataFolderFiles: { kind: 'listed', files: new Map([[GAME_WALL.relativePath, GAME_WALL]]) },
};

beforeEach(() => { handlers.clear(); });

interface Options {
  selection?: readonly unknown[];
  focusedRecord?: string;
  picked?: SymbolName;
}

function setup({ selection = [], focusedRecord, picked }: Options = {}) {
  const referencedBy = vi.fn((_symbol: SymbolName) => Promise.resolve());
  const pick = vi.fn(() => Promise.resolve(picked));
  const reporter = recordingReporter();
  registerReferencedBy({
    reporter, referencedBy, selection: () => selection, filesHeld: () => HELD, focusedRecord: () => focusedRecord, pick,
    dataPathOf: (row) => (row === fileRow ? 'meshes/a.nif' : undefined),
  });
  return { referencedBy, pick, reporter, run: present(handlers.get('modbench.symbol.referencedBy'), 'the referenced by command') };
}

describe('referenced by lists where files name the symbol a row stands for (commands.md, `referenced by` under Symbol)', () => {
  it.each<[string, unknown, SymbolName]>([
    ['a mod row', mod, { kind: 'mod', name: 'Base Mod' }],
    ['a separator row', separator, { kind: 'separator', name: 'Gear' }],
    ['a downloaded file row', downloadedFile, { kind: 'downloadedFile', name: 'Patch-1.7z' }],
    ['a plugin row', pluginRow, { kind: 'plugin', ...BASE }],
    ['a record row', recordRow, { kind: 'record', formKey: GUN }],
    ['a file row', fileRow, { kind: 'file', path: 'meshes/a.nif' }],
  ])('asks for the symbol of %s', async (_what, row, symbol) => {
    const { referencedBy, run } = setup();

    await run(row);

    expect(referencedBy.mock.calls).toEqual([[symbol]]);
  });

  it('asks for the one selected row when none is given, and for no symbol when several are selected', async () => {
    const one = setup({ selection: [pluginRow] });
    await one.run();
    const several = setup({ selection: [pluginRow, mod], picked: undefined });
    await several.run();

    expect([one.referencedBy.mock.calls, one.pick.mock.calls, several.referencedBy.mock.calls, several.pick.mock.calls.length]).toEqual([[[{ kind: 'plugin', ...BASE }]], [], [], 1]);
  });

  it('refuses a row that stands for no symbol, saying why', async () => {
    const { referencedBy, reporter, run } = setup();

    await run({ a: 'row of no symbol' });

    expect([referencedBy.mock.calls, reporter.reports.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['error', 'It is not a symbol.']]]);
  });
});

describe('referenced by on a file the Explorer shows', () => {
  it('asks for the file, in a mod or the game\'s Data folder, by its path in the Data folder', async () => {
    const { referencedBy, run } = setup();

    await run(Uri.file(WALL.path));
    await run(Uri.file(GAME_WALL.path));

    expect(referencedBy.mock.calls).toEqual([[{ kind: 'file', path: WALL.relativePath }], [{ kind: 'file', path: GAME_WALL.relativePath }]]);
  });

  it('refuses a file in no mod and outside the game\'s Data folder', async () => {
    const { referencedBy, reporter, run } = setup();

    await run(Uri.file('/instance/profiles/Default/modlist.txt'));

    expect([referencedBy.mock.calls, reporter.reports.map(({ severity }) => severity)]).toEqual([[], ['error']]);
  });
});

describe('referenced by from the palette, with nothing given or selected', () => {
  it('asks about the record tab in focus, without asking for a symbol', async () => {
    const { referencedBy, pick, run } = setup({ focusedRecord: GUN });

    await run();

    expect([referencedBy.mock.calls, pick.mock.calls]).toEqual([[[{ kind: 'record', formKey: GUN }]], []]);
  });

  it('asks about the symbol the user picks', async () => {
    const picked: SymbolName = { kind: 'file', path: 'meshes/a.nif' };
    const { referencedBy, run } = setup({ picked });

    await run();

    expect(referencedBy.mock.calls).toEqual([[picked]]);
  });

  it('asks about nothing when the user picks nothing', async () => {
    const { referencedBy, run } = setup();

    await run();

    expect(referencedBy).not.toHaveBeenCalled();
  });
});
