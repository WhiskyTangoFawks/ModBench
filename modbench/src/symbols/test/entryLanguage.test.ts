import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { CompletionItemKind, SymbolKind } from './iconsMock';
import { SEARCH } from './fakeKinds';

const setInput = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState, SymbolKind, CompletionItemKind,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  workspace: { textDocuments: [] },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
}));

import { entryLanguage } from '../entryLanguage';
import type { EntryNames, EntrySymbol, PlaceInFile } from '../../symbolNames/symbolNames';
import { recordingReporter } from '../../test/surfacingDoubles';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';

const MODLIST = '/profiles/Default/modlist.txt';
const UNREAD = '/profiles/Other/modlist.txt: it does not read';
const place = (file: string, line: number): PlaceInFile => ({ file, start: { line, character: 1 }, end: { line, character: 9 } });
const document = { uri: Uri.file(MODLIST), getText: () => '# list\nbase mod\n' };
const AT_NAME = 10;
type EntryNamed = NonNullable<Awaited<ReturnType<EntryNames['nameAt']>>>;
type EntryPlace = Awaited<ReturnType<EntryNames['listed']>>[number];

const mod = (name: string): EntrySymbol => ({ kind: 'mod', name });
const separator = (name: string): EntrySymbol => ({ kind: 'separator', name });
const downloadedFile = (name: string): EntrySymbol => ({ kind: 'downloadedFile', name });
const profile = (name: string): EntrySymbol => ({ kind: 'profile', name });
const spelled = (entry: EntrySymbol): EntryNamed => ({ entry, start: 7, end: 15 });
const SPAN = { start: 7, end: 15 };
const locationAt = (line: number) => ({ uri: Uri.file(MODLIST), range: new Range(line, 1, line, 9) });
const located = (found: readonly { uri: unknown; range: unknown }[] | undefined) => found?.map(({ uri, range }) => ({ uri, range }));
const SHOW_BASE_MOD = vi.fn(() => Promise.resolve());
const SHOW_GEAR = vi.fn(() => Promise.resolve());
const SHOW_PATCH = vi.fn(() => Promise.resolve());

interface Options {
  places?: PlaceInFile[];
  leftOut?: string[];
  tooltip?: string;
  downloadedFileTooltip?: string;
  listed?: EntryPlace[];
  listedFails?: boolean;
  shown?: boolean;
}

function language(named: EntryNamed | undefined, options: Options = {}) {
  const renameEntry = vi.fn(() => Promise.resolve());
  const reporter = recordingReporter();
  const reads = vi.fn();
  const owner: EntryNames = {
    listed: () => (options.listedFails ? Promise.reject(new Error('the list is gone')) : Promise.resolve(options.listed ?? [])),
    read: (entry) => { reads(entry); return Promise.resolve({ references: options.places ?? [place(MODLIST, 1)], leftOut: options.leftOut ?? [] }); },
    nameAt: () => Promise.resolve(named),
  };
  const mods = [
    { kind: 'mod' as const, name: 'Base Mod', enabled: true }, { kind: 'mod' as const, name: 'Other Mod', enabled: true },
    { kind: 'separator' as const, name: 'Gear', enabled: true },
  ];
  const shownRows: Record<string, typeof SHOW_BASE_MOD> = { 'mod:Base Mod': SHOW_BASE_MOD, 'separator:Gear': SHOW_GEAR };
  const rows = {
    show: ({ kind, name }: { kind: string; name: string }) => (options.shown === false ? undefined : shownRows[`${kind}:${name}`]),
    folderOf: (name: string) => (name === 'Base Mod' ? '/instance/mods/Base Mod' : undefined),
  };
  const value = { mods, downloadedFiles: { kind: 'listed' as const, rows: [downloadedFileRowFixture('Patch-1.7z'), downloadedFileRowFixture('Armor-2.zip')] }, profiles: ['Default', 'Armor Test'] };
  return { reporter, reads, ...entryLanguage({
    instance: { value }, reporter, owners: [owner], rows: () => rows, entryTooltip: () => options.tooltip, downloadedFileTooltip: () => options.downloadedFileTooltip,
    downloadedFileRow: (name) => (options.shown !== false && name === 'Patch-1.7z' ? SHOW_PATCH : undefined),
    modOrderFileOf: (name) => `/profiles/${name}/modlist.txt`, renameEntry,
  }), renameEntry };
}

describe('the name of a mod, a separator, a downloaded file or a profile where an owner\'s file names it (symbols.md, The symbols)', () => {
  it('spans the name the owner answers', async () => {
    expect(await language(spelled(mod('base mod'))).nameAt(document, AT_NAME)).toEqual({ ...SPAN, name: 'base mod', symbol: mod('base mod') });
  });

  it('is none where the owner names none, so another kind may claim the place', async () => {
    const none = language(undefined);

    expect([await none.nameAt(document, AT_NAME), await none.completionsAt(document, AT_NAME)]).toEqual([undefined, undefined]);
  });
});

describe('Rename Symbol on a mod or a separator (symbols.md, The features, story 6)', () => {
  it.each([
    ['a mod', mod('base mod'), { kind: 'mod', name: 'Base Mod' }],
    ['a separator', separator('gear'), { kind: 'separator', name: 'Gear' }],
  ])('on %s, offers its name as the file spells it and is its rename, by the name the instance spells it', async (_case, spelledAs, listed) => {
    const { renameRangeAt, renameAt, renameEntry } = language(spelled(spelledAs));

    expect(await renameRangeAt(document, AT_NAME)).toEqual({ ...SPAN, name: spelledAs.name });
    expect(await renameAt(document, AT_NAME, 'Renamed')).toBe(true);
    expect(renameEntry).toHaveBeenCalledWith(listed, 'Renamed');
  });

  it.each([
    ['a downloaded file', downloadedFile('Patch-1.7z')],
    ['a profile', profile('Default')],
  ])('offers nothing on %s, which has no rename gesture, and renames nothing', async (_case, entry) => {
    const { renameRangeAt, renameAt, renameEntry } = language(spelled(entry));

    expect(await renameRangeAt(document, AT_NAME)).toBeUndefined();
    expect(await renameAt(document, AT_NAME, 'Renamed')).toBe(false);
    expect(renameEntry).not.toHaveBeenCalled();
  });

  it('offers nothing where no owner names an entry', async () => {
    expect(await language(undefined).renameRangeAt(document, AT_NAME)).toBeUndefined();
  });

  it('refuses a mod no row lists, and renames nothing', async () => {
    const { renameAt, renameEntry } = language(spelled(mod('Gone Mod')));

    await expect(renameAt(document, AT_NAME, 'Renamed')).rejects.toThrow('Mods lists no mod named Gone Mod.');
    expect(renameEntry).not.toHaveBeenCalled();
  });
});

describe('where a mod, a separator, a downloaded file or a profile is defined (symbols.md, The symbols)', () => {
  it('is a mod\'s row in Mods, by the name as the instance spells it', async () => {
    expect(await language(undefined).definitionOf(mod('base mod'))).toEqual({ row: 'Mods', show: SHOW_BASE_MOD });
  });

  it('is a separator\'s row in Mods', async () => {
    expect(await language(undefined).definitionOf(separator('gear'))).toEqual({ row: 'Mods', show: SHOW_GEAR });
  });

  it('is a downloaded file\'s row in Downloads', async () => {
    expect(await language(undefined).definitionOf(downloadedFile('patch-1.7z'))).toEqual({ row: 'Downloads', show: SHOW_PATCH });
  });

  it('is a mod\'s folder when Mods shows no row for it', async () => {
    expect(await language(undefined, { shown: false }).definitionOf(mod('Base Mod'))).toEqual({ shown: { kind: 'loose', path: '/instance/mods/Base Mod' } });
  });

  it.each<[string, EntrySymbol, object, Options?]>([
    ['refuses a mod no row lists', mod('Gone Mod'), { refused: 'Mods lists no mod named Gone Mod.' }],
    ['refuses a mod with neither a row nor a folder', mod('Other Mod'), { refused: 'Mods shows no row for it and no folder holds it.' }],
    ['gives a profile no definition', profile('Default'), { none: 'A profile has no definition.' }],
    ['refuses a separator whose row Mods does not show', separator('Gear'), { refused: 'Mods shows no row for it.' }, { shown: false }],
    ['refuses a downloaded file whose row Downloads does not show', downloadedFile('Patch-1.7z'), { refused: 'Downloads shows no row for it.' }, { shown: false }],
    ['refuses a separator no row lists', separator('Gone'), { refused: 'Mods lists no separator named Gone.' }],
    ['refuses a downloaded file no row lists', downloadedFile('Gone.7z'), { refused: 'Downloads lists no downloaded file named Gone.7z.' }],
    ['refuses a profile the instance does not hold', profile('Gone'), { refused: 'The instance holds no profile named Gone.' }],
  ])('%s', async (_case, entry, expected, options) => {
    expect(await language(undefined, options).definitionOf(entry)).toEqual(expected);
  });
});

describe('the places files name a mod, a separator, a downloaded file or a profile (symbols.md, The features, story 2)', () => {
  it('lists each place the owners report, naming each file they could not read', async () => {
    const found = await language(undefined, { leftOut: [UNREAD] }).referencesTo(profile('armor test'));

    expect('locations' in found && [located(found.locations), found.unread]).toEqual([[locationAt(1)], [UNREAD]]);
  });

  it.each([
    ['a separator', separator('Gear')], ['a downloaded file, whatever its case', downloadedFile('patch-1.7z')], ['a profile', profile('Default')],
  ])('lists the places of %s too', async (_case, entry) => {
    const found = await language(undefined).referencesTo(entry);

    expect('locations' in found && located(found.locations)).toEqual([locationAt(1)]);
  });

  it.each([
    [mod('Gone Mod'), 'Mods lists no mod named Gone Mod.'],
    [separator('Gone'), 'Mods lists no separator named Gone.'],
    [downloadedFile('Gone.7z'), 'Downloads lists no downloaded file named Gone.7z.'],
    [profile('Gone'), 'The instance holds no profile named Gone.'],
  ])('refuses to list what names one nothing has the name of, and asks no owner: %o', async (entry, refused) => {
    const { reads, ...kind } = language(undefined);

    expect(await kind.referencesTo(entry)).toEqual({ refused });
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('hover and completion on a mod, a separator, a downloaded file or a profile (symbols.md, The features, stories 3 and 5)', () => {
  const hovered = (entry: EntrySymbol, options: Options = {}) => language(undefined, options).tooltipOf(entry);

  it.each([
    ['the row\'s tooltip, a line to each of its lines', mod('base mod'), 'Base Mod · 1.0\nbuilt from source/Base Mod', ['Base Mod · 1.0', 'built from source/Base Mod']],
    ['none when its row shows no tooltip, as a separator\'s does not', separator('Gear'), undefined, []],
    ['none when Mods lists no such mod', mod('Gone Mod'), undefined, []],
  ])('its tooltip is %s', async (_case, entry, tooltip, lines) => {
    expect(await hovered(entry, { tooltip })).toEqual(lines);
  });

  it.each([
    ['a downloaded file\'s row\'s, never a mod\'s', downloadedFile('patch-1.7z'), ['Patch-1.7z', 'size 1 KB']],
    ['none for a profile, which no row shows, never a mod\'s', profile('Default'), []],
  ])('its tooltip is %s', async (_case, entry, lines) => {
    expect(await hovered(entry, { tooltip: 'a mod\'s tooltip', downloadedFileTooltip: 'Patch-1.7z\nsize 1 KB' })).toEqual(lines);
  });

  it.each([
    ['a mod, every mod', mod('Base'), ['Base Mod', 'Other Mod'], CompletionItemKind.Folder],
    ['a separator, every separator', separator('Gea'), ['Gear'], CompletionItemKind.Folder],
    ['a downloaded file, every downloaded file', downloadedFile('P'), ['Patch-1.7z', 'Armor-2.zip'], CompletionItemKind.File],
    ['a profile, every profile', profile('D'), ['Default', 'Armor Test'], CompletionItemKind.Folder],
  ])('completes where a file names %s, over the name so far', async (_case, entry, items, icon) => {
    expect(await language(spelled(entry)).completionsAt(document, AT_NAME)).toEqual({ ...SPAN, icon, items: items.map((label) => ({ label })) });
  });
});

describe('Go to Symbol in Workspace on a mod, a separator, a downloaded file or a profile (symbols.md, The features, story 4)', () => {
  const names = (found: readonly { name: string; detail: string }[]) => found.map(({ name, detail }) => [detail, name]);

  it('lists each mod and separator whose name holds the query, whatever the case, at the first place a file names it', async () => {
    const kind = language(undefined);

    expect(names(await kind.symbolsFor('ge', SEARCH))).toEqual([['mod separator', 'Gear']]);
    expect(names(await kind.symbolsFor('MOD', SEARCH))).toEqual([['mod', 'Base Mod'], ['mod', 'Other Mod']]);
  });

  it('places an entry its owners\' list names at its line there, and asks the owners for no other entry than one the list leaves out', async () => {
    const { reads, ...kind } = language(undefined, { listed: [{ entry: mod('base mod'), place: place(MODLIST, 4) }, { entry: separator('Gear'), place: place(MODLIST, 5) }] });

    const found = await kind.symbolsFor('mod', SEARCH);

    expect(names(found)).toEqual([['mod', 'Base Mod'], ['mod', 'Other Mod']]);
    expect(located(found.map(({ location }) => location))).toEqual([locationAt(4), locationAt(1)]);
    expect(reads.mock.calls).toEqual([[mod('Other Mod')]]);
  });

  it('places a downloaded file at its own file and a profile at its mod order file, even where no file names them, reading no file', async () => {
    const { reads, ...kind } = language(undefined, { places: [] });

    const found = await kind.symbolsFor('ARMOR', SEARCH);

    expect(names(found)).toEqual([['downloaded file', 'Armor-2.zip'], ['profile', 'Armor Test']]);
    expect(located(found.map(({ location }) => location))).toEqual([
      { uri: Uri.file(downloadedFileRowFixture('Armor-2.zip').path), range: new Range(0, 0, 0, 0) }, { uri: Uri.file('/profiles/Armor Test/modlist.txt'), range: new Range(0, 0, 0, 0) },
    ]);
    expect(reads).not.toHaveBeenCalled();
  });

  it('reads nothing for entries a broad query matches when the list names every one', async () => {
    const listed = [mod('Base Mod'), mod('Other Mod'), separator('Gear'), downloadedFile('Patch-1.7z'), downloadedFile('Armor-2.zip'), profile('Default'), profile('Armor Test')];
    const { reads, ...kind } = language(undefined, { listed: listed.map((entry, line) => ({ entry, place: place(MODLIST, line) })) });

    expect(await kind.symbolsFor('e', SEARCH)).toHaveLength(5);
    expect(reads).not.toHaveBeenCalled();
  });

  it('says in the Output why a list could not be read, and asks the owners for each entry instead', async () => {
    const { reads, reporter, ...kind } = language(undefined, { listedFails: true });

    expect(names(await kind.symbolsFor('gear', SEARCH))).toEqual([['mod separator', 'Gear']]);
    expect([reads.mock.calls, reporter.shownFailures.map(({ severity, detail }) => [severity, detail])]).toEqual([[[separator('Gear')]], [['warning', 'the list is gone']]]);
  });

  it('lists no entry that no file names', async () => {
    expect(await language(undefined, { places: [] }).symbolsFor('mod', SEARCH)).toEqual([]);
  });

  it('selects a mod\'s row in Mods when the user picks it, as its definition is', async () => {
    SHOW_BASE_MOD.mockClear();
    const [picked] = await language(undefined).symbolsFor('base', SEARCH);

    expect(await picked?.resolve?.()).toBeUndefined();
    expect(SHOW_BASE_MOD).toHaveBeenCalledOnce();
  });
});

describe('referenced by on a mod (commands.md, `referenced by` under Symbol)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it.each<[string, EntrySymbol, string]>([
    ['a mod', mod('Base Mod'), 'modbench.modReferencedBy'],
    ['a separator', separator('Gear'), 'modbench.separatorReferencedBy'],
  ])('lists the places the owners report for %s, titled with its name', async (_what, entry, contextValue) => {
    await language(undefined).referencedBy(entry);

    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({ title: `Referenced By: ${entry.name}`, contextValue, location: expect.objectContaining(locationAt(1)) as unknown }));
  });
});
