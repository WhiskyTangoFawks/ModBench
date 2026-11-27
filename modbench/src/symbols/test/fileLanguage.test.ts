import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { CompletionItemKind, document, host, Location, Range, Uri } from './vscodeHost';
import { instanceHolding, rowsOf, symbolsOver } from './symbolsOver';
import { mEditNames } from './mEditNames';
import type { DocumentName } from '../../client';
import type { PlacedReferences } from '../../client/MEditClient';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FileConflictLookup, foldPath, NO_GAME_FOLDER_ARCHIVED, type CopyAt, type StackedFile } from '../../instanceLoader/fileConflictIndex';

const TEXT = '{ "FormKey": "000801:Mod.esp", "Diffuse": "Decals\\\\Stain_d.dds", "EditorID": "Stain" }';
const HOLDER = '000801:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/TextureSet.json';
const NAMED = TEXT.indexOf('Decals');
const FILE = 'textures/decals/stain_d.dds';
const UNREAD = '000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx';
const ARCHIVE = '/instance/mods/Mod/Mod - Textures.ba2';
const SPELLED = 'Decals\\\\Stain_d.dds';
const PLACED = { start: { line: 0, character: NAMED }, end: { line: 0, character: NAMED + SPELLED.length } };
const SPAN = { start: NAMED, end: NAMED + SPELLED.length };
const AT_PATH = `${TEXT.slice(0, NAMED + 2)}|${TEXT.slice(NAMED + 2)}`;

const LOOSE: CopyAt = { kind: 'loose', path: '/instance/mods/Mod/Textures/Decals/Stain_d.dds' };
const ARCHIVED = { kind: 'archived', gameRelease: 'Fallout4', archive: ARCHIVE, file: 'textures/decals/other_d.dds' } as const satisfies CopyAt;

const NO_COPY = { none: `No enabled mod, Overwrite or loose file in the Data folder holds ${FILE}.` };
const NONE = { copies: [], leftOut: [] };
const NAMES_FILE = { kind: 'File' as const, ...SPAN, value: 'Decals\\Stain_d.dds', dataPath: FILE };

interface Doubles {
  copy?: CopyAt | { none: string };
  named?: readonly DocumentName[];
  tooltip?: string;
  rocks?: number;
}

function language(answer: PlacedReferences, { copy = LOOSE, named = [NAMES_FILE], tooltip, rocks = 0 }: Doubles = {}) {
  const reveal = vi.fn(() => Promise.resolve());
  const stackedCopies = new FileConflictLookup<StackedFile>();
  stackedCopies.set({ relativePath: 'Textures/Decals/Stain_d.dds', copies: [] });
  Array.from({ length: rocks }, (_, rock) => stackedCopies.set({ relativePath: `meshes/rocks/rock${rock}.nif`, copies: [] }));
  const value = instanceValueFixture({
    stackedCopies, gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' }, gameFolderInWorkspace: true,
    dataFolderFiles: {
      kind: 'listed',
      files: new Map(['meshes/rock.nif', 'meshes/textures/stray.dds', 'textures/readme.txt'].map((path) => [path, { path: `/game/Data/${path}`, relativePath: path }])),
    },
    gameFolderArchived: { ...NO_GAME_FOLDER_ARCHIVED, copies: new Map([['textures/decals/other_d.dds', ARCHIVED]]) },
  });
  const copyOf = vi.fn((path: string) => {
    if (foldPath(path) === FILE) return copy;
    if (path.startsWith('meshes/rocks/')) return { kind: 'loose' as const, path: `/instance/mods/Rocks/${path}` };
    return foldPath(path) === ARCHIVED.file ? ARCHIVED : NO_COPY;
  });
  const made = symbolsOver({
    instance: instanceHolding(value), names: mEditNames(() => named), fileCopies: { copyOf, reveal },
    rows: rowsOf({ mods: { fileTooltip: () => tooltip, dataPathOf: (row) => (row === FILE_ROW ? FILE : undefined) } }),
    arrange: (client) => { client.setQueryAnswer('getPlacedFileReferences', answer); },
  });
  return { ...made, reveal, copyOf, stackedCopies };
}

const FILE_ROW = { label: 'Stain_d.dds' };
const atCopy = (path: string) => new Location(Uri.file(path), new Range(0, 0, 0, 0));

describe('a path in plugin source names a file (symbols.md, The symbols, File)', () => {
  it.each([
    ['the file by its path in the Data folder', NAMES_FILE, FILE],
    ['nothing, saying why, by the path as given, where mEdit could not tell which file it names', { ...NAMES_FILE, dataPath: null, refusal: 'Data/Stain_d.dds is no path its asset type holds' }, 'Decals\\Stain_d.dds'],
  ])('names %s', async (_case, named, text) => {
    language(NONE, { named: [named] });

    expect(await host.hover(SOURCE, AT_PATH)).toEqual({ text, spans: SPELLED });
  });

  it.each([
    ['its row\'s, a line to each of its lines', 'Main.ba2/textures/decals/stain_d.dds\nwon by the game folder: /game/Data/textures/decals/stain_d.dds', 'Main.ba2/textures/decals/stain_d.dds\n\nwon by the game folder: /game/Data/textures/decals/stain_d.dds'],
    ['none where Mods shows no row for it, so its hover is its path', undefined, FILE],
  ])('its tooltip is %s', async (_case, tooltip, text) => {
    language(NONE, { tooltip });

    expect((await host.hover(SOURCE, AT_PATH))?.text).toEqual(text);
  });
});

describe('where a file is defined, and the records that name it (symbols.md, The symbols, File)', () => {
  it.each([
    ['a loose file at the copy the game gets', LOOSE, { file: LOOSE.path }],
    ['an archived file inside its archive', ARCHIVED, { archived: { archive: ARCHIVE, file: ARCHIVED.file } }],
    ['nothing for a file no copy exists of, refusing with what was searched', NO_COPY, { refused: NO_COPY.none }],
  ])('defines %s', async (_case, copy, expected) => {
    expect(await language(NONE, { copy }).symbols.definitionOf({ kind: 'file', path: FILE })).toEqual(expected);
  });

  it('lists each record that names it at its member, and each copy it could not read', async () => {
    const { symbols } = language({
      copies: [{ formKey: HOLDER, plugin: { name: 'Mod.esp', origin: 'Mod' }, document: { kind: 'OwnFile', location: SOURCE }, ranges: [PLACED] }], leftOut: [UNREAD],
    });

    expect(await symbols.referencesTo({ kind: 'file', path: FILE })).toEqual({ references: [{ file: SOURCE, ...PLACED }], leftOut: [UNREAD] });
  });
});

describe('Go to Symbol in Workspace on a file (symbols.md, The features, story 4)', () => {
  const listed = async (query: string) => (await host.workspaceSymbols(query)).map(({ name, location }) => [name, location]);

  it('lists each file of a mod, the Data folder or a game archive whose path holds the query, whatever the case, at the copy the game gets', async () => {
    language(NONE);

    expect(await listed('DECALS')).toEqual([['Textures/Decals/Stain_d.dds', atCopy(LOOSE.path)], ['textures/decals/other_d.dds', atCopy(ARCHIVE)]]);
  });

  it('reads a query spelled with backslashes as one spelled with forward slashes', async () => {
    language(NONE);

    expect((await listed('Decals\\Stain')).map(([name]) => name)).toEqual(['Textures/Decals/Stain_d.dds']);
  });

  it('lists no file the game gets no copy of, and says in the Output that it matched and went unlisted', async () => {
    const { reporter } = language(NONE);

    expect(await listed('rock')).toEqual([]);
    expect(reporter.shownFailures.map(({ severity, message }) => [severity, message])).toEqual([['warning', 'Go to Symbol in Workspace lists 0 of the 1 files whose path holds "rock".']]);
  });

  it('lists at most a thousand files on a modlist of many, placing no more, and says in the Output how many more match (principles.md, Usable first; Never silently wrong)', async () => {
    const { reporter, copyOf } = language(NONE, { rocks: 1001 });

    expect([(await listed('rocks/')).length, copyOf.mock.calls.length]).toEqual([1000, 1000]);
    expect(reporter.shownFailures.map(({ message, detail }) => [message, detail])).toEqual([[
      'Go to Symbol in Workspace lists 1000 of the 1001 files whose path holds "rocks/".',
      'It lists at most 1000, and none whose copy the game gets is outside the workspace. Type more of the path to narrow the list.',
    ]]);
  });

  it('lists every match, saying nothing, where no more match than it lists', async () => {
    const { reporter } = language(NONE, { rocks: 2 });

    expect([(await listed('rocks/')).map(([name]) => name), reporter.shownFailures]).toEqual([['meshes/rocks/rock0.nif', 'meshes/rocks/rock1.nif'], []]);
  });

  it('reads an instance value\'s files once, however many keystrokes ask', async () => {
    const { stackedCopies } = language(NONE, { rocks: 10 });
    const read = vi.spyOn(stackedCopies, 'values');

    await host.workspaceSymbols('r');
    await host.workspaceSymbols('ro');
    await host.workspaceSymbols('roc');

    expect(read).toHaveBeenCalledOnce();
  });

  it('shows the copy in the Explorer when the user picks it, as its definition is', async () => {
    const { reveal } = language(NONE);
    const [picked] = await host.workspaceSymbols('stain');

    expect([(picked && await host.resolveWorkspaceSymbol(picked))?.location, reveal.mock.calls]).toEqual([atCopy(LOOSE.path), [[LOOSE]]]);
  });
});

describe('completion at a path (symbols.md, The features, story 5)', () => {
  const TEXTURES = { folder: 'Textures', extensions: ['.DDS'] };
  const MESHES = { folder: 'Meshes', extensions: ['.nif'] };
  const offeredFor = (typed: string, assetType = TEXTURES, rocks = 0) => {
    const field = `{ "Diffuse": "${typed}" }`;
    const start = field.indexOf(typed, field.indexOf(': '));
    const { reporter } = language(NONE, { named: [{ kind: 'File', start, end: start + typed.length, value: typed, assetType }], rocks });
    return { reporter, found: host.complete(SOURCE, `${field.slice(0, start + typed.length)}|${field.slice(start + typed.length)}`) };
  };

  it('offers each file in its asset type\'s folder, whatever the case, that takes one of its extensions, as plugin source spells it', async () => {
    expect(await offeredFor('').found).toEqual({
      isIncomplete: false,
      items: [
        { label: 'Decals\\Stain_d.dds', detail: undefined, kind: CompletionItemKind.File, insertText: 'Decals\\\\Stain_d.dds', replaces: '' },
        { label: 'decals\\other_d.dds', detail: undefined, kind: CompletionItemKind.File, insertText: 'decals\\\\other_d.dds', replaces: '' },
      ],
    });
  });

  it.each([
    ['below its folder, its backslashes escaped', 'Decals\\\\St', ['Decals\\Stain_d.dds']],
    ['below its folder, with forward slashes', 'decals/st', ['Decals\\Stain_d.dds']],
    ['from its folder, spelling each file from it', 'Textures\\\\Decals\\\\St', ['Textures\\Decals\\Stain_d.dds']],
  ])('offers only the files whose path holds the text typed so far, spelled %s', async (_case, typed, labels) => {
    expect((await offeredFor(typed).found)?.items.map(({ label }) => label)).toEqual(labels);
  });

  it('offers nothing where no path is', async () => {
    language(NONE, { named: [] });

    expect(await host.complete(SOURCE, AT_PATH)).toBeUndefined();
  });

  it.each([
    ['nothing is typed', '', 'Completion lists 1000 of the 1002 files in Meshes.'],
    ['some of the path is typed', 's', 'Completion lists 1000 of the 1001 files in Meshes whose path holds "s".'],
  ])('offers at most a thousand files where %s, so VS Code asks again as the user types, and says in the Output how many more match (principles.md, Never silently wrong)', async (_case, typed, message) => {
    const { reporter, found } = offeredFor(typed, MESHES, 1001);

    expect(await found.then((offered) => [offered?.items.length, offered?.isIncomplete])).toEqual([1000, true]);
    expect(reporter.shownFailures.map(({ message: said, detail }) => [said, detail])).toEqual([[message, 'It lists at most 1000. Type more of the path to narrow the list.']]);
  });
});

describe('referenced by on a file (commands.md, `referenced by` under Symbol)', () => {
  it('lists the records that name its path in the Data folder, titled with the path', async () => {
    const { client } = language({
      copies: [{ formKey: HOLDER, plugin: { name: 'Mod.esp', origin: 'Mod' }, document: { kind: 'OwnFile', location: SOURCE }, ranges: [PLACED] }], leftOut: [],
    });
    host.holds([document(SOURCE, TEXT)]);

    await host.run('modbench.symbol.referencedBy', FILE_ROW);

    expect(client.calls.filter(({ method }) => method === 'getPlacedFileReferences').map(({ args }) => args)).toEqual([[FILE, undefined]]);
    expect(host.referencesShown).toEqual([expect.objectContaining({
      title: `Referenced By: ${FILE}`, contextValue: 'modbench.fileReferencedBy', location: new Location(Uri.file(SOURCE), new Range(0, PLACED.start.character, 0, PLACED.end.character)),
    })]);
  });
});
