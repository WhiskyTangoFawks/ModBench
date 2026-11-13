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
}

function language(answer: Awaited<ReturnType<FileClient['getFileReferences']>>, { copy = LOOSE, resolve = () => Promise.resolve(FILE), compare }: Doubles = {}) {
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
  const value = {
    stackedCopies,
    dataFolderFiles: { kind: 'listed' as const, files: new Map([['meshes/rock.nif', { path: '/game/Data/meshes/rock.nif', relativePath: 'meshes/rock.nif' }]]) },
    gameFolderArchived: { ...NO_GAME_FOLDER_ARCHIVED, copies: new Map([['textures/decals/other_d.dds', ARCHIVED]]) },
  };
  const copyOf = vi.fn((path: string) => {
    if (path.toLowerCase() === FILE) return copy;
    return path === ARCHIVED.file ? ARCHIVED : NO_COPY;
  });
  return { reporter, getFileReferences, resolveFilePath, reveal, ...fileLanguage({ instance: { value }, reporter, client, gameRelease: () => Promise.resolve('Fallout4'), copyOf, reveal }) };
}

describe('a path in plugin source names a file (symbols.md, The symbols, File)', () => {
  const document = (path = SOURCE) => ({ uri: Uri.file(path), getText: () => TEXT });
  const SPAN = { start: NAMED, end: NAMED + 'Decals\\\\Stain_d.dds'.length };

  it('names the file at its path in the Data folder, asking mEdit which file the record\'s path names', async () => {
    const { resolveFilePath, ...kind } = language(NONE);

    expect(await kind.nameAt(document(), NAMED + 2)).toEqual({ ...SPAN, spelled: 'Decals\\Stain_d.dds', symbol: { kind: 'file', path: FILE } });
    expect(resolveFilePath.mock.calls).toEqual([['Fallout4', 'txst', JSON.stringify(JSON.parse(TEXT)), 'Diffuse']]);
  });

  it('names nothing, saying why, where mEdit could not tell which file the path names', async () => {
    const kind = language(NONE, { resolve: () => Promise.resolve(localFailure('Data/Stain_d.dds is no path its asset type holds')) });

    expect(await kind.nameAt(document(), NAMED + 2)).toEqual({ ...SPAN, spelled: 'Decals\\Stain_d.dds', symbol: { refused: 'Data/Stain_d.dds is no path its asset type holds' } });
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

  it('hovers with its path in the Data folder, else the path as the field spells it', async () => {
    const kind = language(NONE);

    expect([
      await kind.hoverOf({ ...SPAN, spelled: 'Decals\\Stain_d.dds', symbol: { kind: 'file', path: FILE } }),
      await kind.hoverOf({ ...SPAN, spelled: 'Decals\\Stain_d.dds', symbol: { refused: 'no path' } }),
    ]).toEqual([[FILE], ['Decals\\Stain_d.dds']]);
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
    const found = await language(NONE).symbolsFor(' DECALS ');

    expect(found.map(({ name, location }) => [name, location])).toEqual([
      ['Textures/Decals/Stain_d.dds', { uri: Uri.file(LOOSE.path), range: { line: 0, character: 0 } }],
      ['textures/decals/other_d.dds', { uri: Uri.file(ARCHIVE), range: { line: 0, character: 0 } }],
    ]);
  });

  it('lists no file the game gets no copy of, and nothing for an empty query', async () => {
    const kind = language(NONE);

    expect([await kind.symbolsFor('rock'), await kind.symbolsFor(' ')]).toEqual([[], []]);
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

  it('lists the records that name its path in the Data folder, at the member that names it, and notifies of a record it could not read', async () => {
    const { referencedBy, reporter, getFileReferences } = language({
      copies: [{ formKey: HOLDER, plugin: { name: 'Mod.esp', origin: 'Mod' }, inPluginSource: true, fieldPaths: ['Diffuse'] }], unread: [UNREAD],
    });

    await referencedBy(FILE);

    expect(getFileReferences.mock.calls).toEqual([[FILE]]);
    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({
      title: `Referenced By: ${FILE}`, location: { uri: Uri.file(SOURCE), range: { start: { line: 0, character: NAMED }, end: { line: 0, character: NAMED + 'Decals\\\\Stain_d.dds'.length } } },
    }));
    expect(reporter.reports.map(({ severity, detail }) => [severity, detail])).toEqual([['warning', UNREAD]]);
  });

  it('says that no file names it, which leaves the view where it was', async () => {
    const { referencedBy, reporter } = language(NONE);

    await referencedBy(FILE);

    expect([setInput.mock.calls, reporter.reports.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['error', 'No file names it.']]]);
  });
});
