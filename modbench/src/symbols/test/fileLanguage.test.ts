import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { CompletionItemKind, SymbolKind } from './iconsMock';

const { setInput, TEXT } = vi.hoisted(() => ({ setInput: vi.fn(), TEXT: '{ "FormKey": "000801:Mod.esp", "Diffuse": "Decals\\\\Stain_d.dds", "EditorID": "Stain" }' }));
vi.mock('vscode', () => ({
  Uri, TreeItem, TreeItemCollapsibleState, SymbolKind, CompletionItemKind,
  Position: class { constructor(readonly line: number, readonly character: number) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
  workspace: { openTextDocument: () => Promise.resolve({ getText: () => TEXT, positionAt: (offset: number) => ({ line: 0, character: offset }) }) },
}));

import { fileLanguage, type FileClient } from '../fileLanguage';
import { recordingReporter } from '../../test/surfacingDoubles';
import { comparisonOf, fieldOf } from '../../test/comparison';
import { localFailure } from '../../wire/readFailed';
import { FileConflictLookup, NO_GAME_FOLDER_ARCHIVED, type CopyAt, type StackedFile } from '../../instanceLoader/fileConflictIndex';

const HOLDER = '000801:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/TextureSet.json';
const NAMED = TEXT.indexOf('Decals');
const FILE = 'textures/decals/stain_d.dds';
const UNREAD = '000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx';
const ARCHIVE = '/instance/mods/Mod/Mod - Textures.ba2';

const diffuse = fieldOf({ name: 'Diffuse', type: 'string', isAssetLink: true });
const editorId = fieldOf({ name: 'EditorID', type: 'string' });
const LOOSE: CopyAt = { kind: 'loose', path: '/instance/mods/Mod/Textures/Decals/Stain_d.dds' };
const ARCHIVED = { kind: 'archived', gameRelease: 'Fallout4', archive: ARCHIVE, file: 'textures/decals/other_d.dds' } as const satisfies CopyAt;

const NO_COPY = { none: `No enabled mod, Overwrite or loose file in the Data folder holds ${FILE}.` };
const NONE = { copies: [], unread: [] };

interface Doubles {
  copy?: CopyAt | { none: string };
  resolve?: () => ReturnType<FileClient['resolveFilePath']>;
  compare?: FileClient['getComparison'];
  tooltip?: string;
  rocks?: number;
}

function language(answer: Awaited<ReturnType<FileClient['getFileReferences']>>, { copy = LOOSE, resolve = () => Promise.resolve(FILE), compare, tooltip, rocks = 0 }: Doubles = {}) {
  const reporter = recordingReporter();
  const getFileReferences = vi.fn(() => Promise.resolve(answer));
  const resolveFilePath = vi.fn(resolve);
  const reveal = vi.fn(() => Promise.resolve());
  const client: FileClient = {
    getFileReferences,
    resolveFilePath,
    getComparison: compare ?? (() => Promise.resolve(comparisonOf(HOLDER, [{ plugin: 'Mod.esp', recordType: 'txst', isWinner: true, fields: [diffuse, editorId] }]))),
    getRecordOwner: () => Promise.resolve(undefined),
    getCopyDocument: () => Promise.resolve({ kind: 'OwnFile' as const, location: SOURCE }),
  };
  const stackedCopies = new FileConflictLookup<StackedFile>();
  stackedCopies.set({ relativePath: 'Textures/Decals/Stain_d.dds', copies: [] });
  for (let rock = 0; rock < rocks; rock += 1) stackedCopies.set({ relativePath: `meshes/rocks/rock${rock}.nif`, copies: [] });
  const value = {
    stackedCopies,
    dataFolderFiles: { kind: 'listed' as const, files: new Map([['meshes/rock.nif', { path: '/game/Data/meshes/rock.nif', relativePath: 'meshes/rock.nif' }]]) },
    gameFolderArchived: { ...NO_GAME_FOLDER_ARCHIVED, copies: new Map([['textures/decals/other_d.dds', ARCHIVED]]) },
  };
  const copyOf = vi.fn((path: string) => {
    if (path.toLowerCase() === FILE) return copy;
    if (path.startsWith('meshes/rocks/')) return { kind: 'loose' as const, path: `/instance/mods/Rocks/${path}` };
    return path === ARCHIVED.file ? ARCHIVED : NO_COPY;
  });
  return { reporter, getFileReferences, resolveFilePath, reveal, copyOf, stackedCopies, ...fileLanguage({ instance: { value }, reporter, client, gameRelease: () => Promise.resolve('Fallout4'), copyOf, reveal, tooltip: () => tooltip }) };
}

describe('a path in plugin source names a file (symbols.md, The symbols, File)', () => {
  const document = (path = SOURCE) => ({ uri: Uri.file(path), getText: () => TEXT });
  const SPAN = { start: NAMED, end: NAMED + 'Decals\\\\Stain_d.dds'.length };

  it('names the file by its path in the Data folder, asking mEdit which file the record\'s path names', async () => {
    const { resolveFilePath, ...kind } = language(NONE);

    expect(await kind.nameAt(document(), NAMED + 2)).toEqual({ ...SPAN, name: FILE, symbol: { kind: 'file', path: FILE } });
    expect(resolveFilePath.mock.calls).toEqual([['Fallout4', 'txst', JSON.stringify(JSON.parse(TEXT)), 'Diffuse']]);
  });

  it('names nothing, saying why, where mEdit could not tell which file the path names', async () => {
    const kind = language(NONE, { resolve: () => Promise.resolve(localFailure('Data/Stain_d.dds is no path its asset type holds')) });

    expect(await kind.nameAt(document(), NAMED + 2)).toEqual({ ...SPAN, name: 'Decals\\Stain_d.dds', symbol: { refused: 'Data/Stain_d.dds is no path its asset type holds' } });
  });

  it('says why it cannot tell whether the field is a path, when mEdit cannot answer for the record', async () => {
    const { resolveFilePath, reporter, ...kind } = language(NONE, { compare: () => Promise.reject(new Error('mEdit is down')) });

    expect(await kind.nameAt(document(), NAMED + 2)).toBeUndefined();
    expect([resolveFilePath.mock.calls, reporter.shownFailures]).toEqual([[], [{ severity: 'error', message: `Cannot tell whether ${HOLDER} names a file here.`, detail: 'mEdit is down' }]]);
  });

  it.each([
    ['a field that is no path', TEXT.lastIndexOf('Stain') + 2, SOURCE],
    ['a path in a file that is no plugin source', NAMED + 2, '/instance/notes.json'],
  ])('is not %s', async (_case, offset, file) => {
    const { resolveFilePath, ...kind } = language(NONE);

    expect(await kind.nameAt(document(file), offset)).toBeUndefined();
    expect(resolveFilePath).not.toHaveBeenCalled();
  });

  it.each([
    ['its row\'s, a line to each of its lines', 'Main.ba2/textures/decals/stain_d.dds\nwon by the game folder: /game/Data/textures/decals/stain_d.dds', ['Main.ba2/textures/decals/stain_d.dds', 'won by the game folder: /game/Data/textures/decals/stain_d.dds']],
    ['none where Mods shows no row for it', undefined, []],
  ])('its tooltip is %s', async (_case, tooltip, lines) => {
    expect(await language(NONE, { tooltip }).tooltipOf({ kind: 'file', path: FILE })).toEqual(lines);
  });
});

describe('where a file is defined, and the records that name it (symbols.md, The symbols, File)', () => {
  it.each([
    ['a loose file at the copy the game gets', LOOSE, { shown: LOOSE }],
    ['an archived file inside its archive', ARCHIVED, { shown: ARCHIVED }],
    ['nothing for a file no copy exists of, refusing with what was searched', NO_COPY, { refused: NO_COPY.none }],
  ])('defines %s', async (_case, copy, expected) => {
    expect(await language(NONE, { copy }).definitionOf({ kind: 'file', path: FILE })).toEqual(expected);
  });

  it('lists each record that names it at its member, and each copy it could not read', async () => {
    const kind = language({
      copies: [{ formKey: HOLDER, plugin: { name: 'Mod.esp', origin: 'Mod' }, inPluginSource: true, fieldPaths: ['Diffuse'] }], unread: [UNREAD],
    });

    expect(await kind.referencesTo({ kind: 'file', path: FILE })).toEqual({
      locations: [{ uri: Uri.file(SOURCE), range: { start: { line: 0, character: NAMED }, end: { line: 0, character: NAMED + 'Decals\\\\Stain_d.dds'.length } } }],
      unread: [UNREAD],
    });
  });
});

describe('Go to Symbol in Workspace on a file (symbols.md, The features, story 4)', () => {
  it('lists each file of a mod, the Data folder or a game archive whose path holds the query, whatever the case, at the copy the game gets', async () => {
    const found = await language(NONE).symbolsFor('DECALS');

    expect(found.map(({ name, location }) => [name, location])).toEqual([
      ['Textures/Decals/Stain_d.dds', { uri: Uri.file(LOOSE.path), range: { start: 0, end: 0 } }],
      ['textures/decals/other_d.dds', { uri: Uri.file(ARCHIVE), range: { start: 0, end: 0 } }],
    ]);
  });

  it('lists no file the game gets no copy of, and says in the Output that it matched and went unlisted', async () => {
    const { reporter, ...kind } = language(NONE);

    expect(await kind.symbolsFor('rock')).toEqual([]);
    expect(reporter.shownFailures.map(({ severity, message }) => [severity, message])).toEqual([['warning', 'Go to Symbol in Workspace lists 0 of the 1 files whose path holds "rock".']]);
  });

  it('lists at most a thousand files on a modlist of many, placing no more, and says in the Output how many more match (principles.md, Usable first; Never silently wrong)', async () => {
    const { reporter, copyOf, ...kind } = language(NONE, { rocks: 200_000 });

    expect([(await kind.symbolsFor('rocks/')).length, copyOf.mock.calls.length]).toEqual([1000, 1000]);
    expect(reporter.shownFailures.map(({ message, detail }) => [message, detail])).toEqual([[
      'Go to Symbol in Workspace lists 1000 of the 200000 files whose path holds "rocks/".',
      'It lists at most 1000, and none whose copy the game gets is outside the workspace. Type more of the path to narrow the list.',
    ]]);
  });

  it('lists every match, saying nothing, where no more match than it lists', async () => {
    const { reporter, ...kind } = language(NONE, { rocks: 200_000 });

    expect([(await kind.symbolsFor('rock199999.')).map(({ name }) => name), reporter.shownFailures]).toEqual([['meshes/rocks/rock199999.nif'], []]);
  });

  it('reads an instance value\'s files once, however many keystrokes ask', async () => {
    const { stackedCopies, ...kind } = language(NONE, { rocks: 10 });
    const read = vi.spyOn(stackedCopies, 'values');

    await kind.symbolsFor('r');
    await kind.symbolsFor('ro');
    await kind.symbolsFor('roc');

    expect(read).toHaveBeenCalledOnce();
  });

  it('shows the copy in the Explorer when the user picks it, as its definition is', async () => {
    const { reveal, ...kind } = language(NONE);
    const [picked] = await kind.symbolsFor('stain');

    expect(await picked?.resolve?.()).toBeUndefined();
    expect(reveal.mock.calls).toEqual([[LOOSE]]);
  });
});

describe('referenced by on a file (commands.md, `referenced by` under Symbol)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it('lists the records that name its path in the Data folder, titled with the path', async () => {
    const { referencedBy, getFileReferences } = language({
      copies: [{ formKey: HOLDER, plugin: { name: 'Mod.esp', origin: 'Mod' }, inPluginSource: true, fieldPaths: ['Diffuse'] }], unread: [],
    });

    await referencedBy(FILE);

    expect(getFileReferences.mock.calls).toEqual([[FILE]]);
    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({
      title: `Referenced By: ${FILE}`, contextValue: 'modbench.fileReferencedBy',
      location: { uri: Uri.file(SOURCE), range: { start: { line: 0, character: NAMED }, end: { line: 0, character: NAMED + 'Decals\\\\Stain_d.dds'.length } } },
    }));
  });
});
