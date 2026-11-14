import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { CompletionItemKind, SymbolKind } from './iconsMock';
import { SEARCH } from './fakeKinds';

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
import { FileConflictLookup, NO_GAME_FOLDER_ARCHIVED, type CopyAt, type StackedFile } from '../../instanceLoader/fileConflictIndex';
import type { NamedFile } from '../sourceNames';
import { sourceNames } from './fakeSourceNames';

const HOLDER = '000801:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/TextureSet.json';
const NAMED = TEXT.indexOf('Decals');
const FILE = 'textures/decals/stain_d.dds';
const UNREAD = '000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx';
const ARCHIVE = '/instance/mods/Mod/Mod - Textures.ba2';
const SPAN = { start: NAMED, end: NAMED + 'Decals\\\\Stain_d.dds'.length };

const LOOSE: CopyAt = { kind: 'loose', path: '/instance/mods/Mod/Textures/Decals/Stain_d.dds' };
const ARCHIVED = { kind: 'archived', gameRelease: 'Fallout4', archive: ARCHIVE, file: 'textures/decals/other_d.dds' } as const satisfies CopyAt;

const NO_COPY = { none: `No enabled mod, Overwrite or loose file in the Data folder holds ${FILE}.` };
const NONE = { copies: [], unread: [] };

interface Doubles {
  copy?: CopyAt | { none: string };
  named?: NamedFile;
  tooltip?: string;
  rocks?: number;
}

function language(answer: Awaited<ReturnType<FileClient['getFileReferences']>>, { copy = LOOSE, named, tooltip, rocks = 0 }: Doubles = {}) {
  const reporter = recordingReporter();
  const getFileReferences = vi.fn(() => Promise.resolve(answer));
  const reveal = vi.fn(() => Promise.resolve());
  const client: FileClient = {
    getFileReferences,
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
  const names = sourceNames({
    fileAt: () => Promise.resolve(named),
    membersIn: (text, formKey, fieldPaths) => Promise.resolve(formKey === HOLDER && fieldPaths.includes('Diffuse') && text === TEXT ? [SPAN] : []),
  });
  return { reporter, getFileReferences, reveal, copyOf, stackedCopies, ...fileLanguage({ instance: { value }, reporter, client, names, copyOf, reveal, tooltip: () => tooltip }) };
}

describe('a path in plugin source names a file (symbols.md, The symbols, File)', () => {
  const document = { uri: Uri.file(SOURCE), getText: () => TEXT };

  it.each([
    ['the file by its path in the Data folder', { ...SPAN, given: 'Decals\\Stain_d.dds', path: FILE }, { ...SPAN, name: FILE, symbol: { kind: 'file', path: FILE } }],
    ['nothing, saying why, by the path as given, where mEdit could not tell which file it names', { ...SPAN, given: 'Decals\\Stain_d.dds', refused: 'Data/Stain_d.dds is no path its asset type holds' },
      { ...SPAN, name: 'Decals\\Stain_d.dds', symbol: { refused: 'Data/Stain_d.dds is no path its asset type holds' } }],
  ])('names %s', async (_case, named, expected) => {
    expect(await language(NONE, { named }).nameAt(document, NAMED + 2)).toEqual(expected);
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
    const found = await language(NONE).symbolsFor('DECALS', SEARCH);

    expect(found.map(({ name, location }) => [name, location])).toEqual([
      ['Textures/Decals/Stain_d.dds', { uri: Uri.file(LOOSE.path), range: { start: 0, end: 0 } }],
      ['textures/decals/other_d.dds', { uri: Uri.file(ARCHIVE), range: { start: 0, end: 0 } }],
    ]);
  });

  it('lists no file the game gets no copy of, and says in the Output that it matched and went unlisted', async () => {
    const { reporter, ...kind } = language(NONE);

    expect(await kind.symbolsFor('rock', SEARCH)).toEqual([]);
    expect(reporter.shownFailures.map(({ severity, message }) => [severity, message])).toEqual([['warning', 'Go to Symbol in Workspace lists 0 of the 1 files whose path holds "rock".']]);
  });

  it('lists at most a thousand files on a modlist of many, placing no more, and says in the Output how many more match (principles.md, Usable first; Never silently wrong)', async () => {
    const { reporter, copyOf, ...kind } = language(NONE, { rocks: 200_000 });

    expect([(await kind.symbolsFor('rocks/', SEARCH)).length, copyOf.mock.calls.length]).toEqual([1000, 1000]);
    expect(reporter.shownFailures.map(({ message, detail }) => [message, detail])).toEqual([[
      'Go to Symbol in Workspace lists 1000 of the 200000 files whose path holds "rocks/".',
      'It lists at most 1000, and none whose copy the game gets is outside the workspace. Type more of the path to narrow the list.',
    ]]);
  });

  it('lists every match, saying nothing, where no more match than it lists', async () => {
    const { reporter, ...kind } = language(NONE, { rocks: 200_000 });

    expect([(await kind.symbolsFor('rock199999.', SEARCH)).map(({ name }) => name), reporter.shownFailures]).toEqual([['meshes/rocks/rock199999.nif'], []]);
  });

  it('reads an instance value\'s files once, however many keystrokes ask', async () => {
    const { stackedCopies, ...kind } = language(NONE, { rocks: 10 });
    const read = vi.spyOn(stackedCopies, 'values');

    await kind.symbolsFor('r', SEARCH);
    await kind.symbolsFor('ro', SEARCH);
    await kind.symbolsFor('roc', SEARCH);

    expect(read).toHaveBeenCalledOnce();
  });

  it('shows the copy in the Explorer when the user picks it, as its definition is', async () => {
    const { reveal, ...kind } = language(NONE);
    const [picked] = await kind.symbolsFor('stain', SEARCH);

    expect(await picked?.resolve?.()).toBeUndefined();
    expect(reveal.mock.calls).toEqual([[LOOSE]]);
  });
});

describe('referenced by on a file (commands.md, `referenced by` under Symbol)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it('lists the records that name its path in the Data folder, titled with the path', async () => {
    const files = language({
      copies: [{ formKey: HOLDER, plugin: { name: 'Mod.esp', origin: 'Mod' }, inPluginSource: true, fieldPaths: ['Diffuse'] }], unread: [],
    });

    await files.referencedBy({ kind: 'file', path: FILE });

    expect(files.getFileReferences.mock.calls).toEqual([[FILE]]);
    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({
      title: `Referenced By: ${FILE}`, contextValue: 'modbench.fileReferencedBy',
      location: { uri: Uri.file(SOURCE), range: { start: { line: 0, character: NAMED }, end: { line: 0, character: NAMED + 'Decals\\\\Stain_d.dds'.length } } },
    }));
  });
});
