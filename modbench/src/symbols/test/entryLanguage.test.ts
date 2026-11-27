import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { CompletionItemKind, host, Location, Range, Uri } from './vscodeHost';
import { instanceHolding, rowsOf, symbolsOver } from './symbolsOver';
import type { EntryNames, EntrySymbol, PlaceInFile } from '../../symbolNames/symbolNames';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const MODLIST = '/profiles/Default/modlist.txt';
const UNREAD = '/profiles/Other/modlist.txt: it does not read';
const place = (file: string, line: number): PlaceInFile => ({ file, start: { line, character: 1 }, end: { line, character: 9 } });
const MARKED = '# list\nbas|e mod\n';
type EntryNamed = NonNullable<Awaited<ReturnType<EntryNames['nameAt']>>>;
type EntryPlace = Awaited<ReturnType<EntryNames['listed']>>[number];

const mod = (name: string): EntrySymbol => ({ kind: 'mod', name });
const separator = (name: string): EntrySymbol => ({ kind: 'separator', name });
const downloadedFile = (name: string): EntrySymbol => ({ kind: 'downloadedFile', name });
const profile = (name: string): EntrySymbol => ({ kind: 'profile', name });
const spelled = (entry: EntrySymbol): EntryNamed => ({ entry, start: 7, end: 15 });
const locationAt = (line: number) => new Location(Uri.file(MODLIST), new Range(line, 1, line, 9));
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
  const value = instanceValueFixture({ mods, downloadedFiles: { kind: 'listed', rows: [downloadedFileRowFixture('Patch-1.7z'), downloadedFileRowFixture('Armor-2.zip')] }, profiles: ['Default', 'Armor Test'] });
  const made = symbolsOver({
    instance: instanceHolding(value), entryOwners: [owner],
    rows: rowsOf({ mods: {
      show: ({ kind, name }) => (options.shown === false ? undefined : shownRows[`${kind}:${name}`]),
      folderOf: (name) => (name === 'Base Mod' ? '/instance/mods/Base Mod' : undefined),
    } }),
    entryTooltip: () => options.tooltip, downloadedFileTooltip: () => options.downloadedFileTooltip,
    downloadedFileRow: (name) => (options.shown !== false && name === 'Patch-1.7z' ? SHOW_PATCH : undefined),
    modOrderFileOf: (name) => `/profiles/${name}/modlist.txt`,
  });
  return { ...made, reads };
}

const renamed = () => host.executed.filter(([id]) => typeof id === 'string' && id.endsWith('.rename'));

describe('the name of a mod, a separator, a downloaded file or a profile where an owner\'s file names it (symbols.md, The symbols)', () => {
  it('is none where the owner names none, so another kind may claim the place', async () => {
    language(undefined);

    expect([await host.hover(MODLIST, MARKED), await host.complete(MODLIST, MARKED)]).toEqual([undefined, undefined]);
  });
});

describe('Rename Symbol on a mod or a separator (symbols.md, The features, story 6)', () => {
  it.each([
    ['a mod', mod('base mod'), 'modbench.mod.rename', 'Base Mod'],
    ['a separator', separator('gear'), 'modbench.separator.rename', 'Gear'],
  ])('on %s, offers its name as the file spells it and is its rename, by the name the instance spells it', async (_case, spelledAs, command, oldName) => {
    language(spelled(spelledAs));

    expect(await host.prepareRename(MODLIST, MARKED)).toEqual({ spans: 'base mod', placeholder: spelledAs.name });
    await host.rename(MODLIST, MARKED, 'Renamed');
    expect(renamed()).toEqual([[command, undefined, undefined, { oldName, newName: 'Renamed' }]]);
  });

  it.each([
    ['a downloaded file', downloadedFile('Patch-1.7z')],
    ['a profile', profile('Default')],
  ])('offers nothing on %s, which has no rename gesture, and renames nothing', async (_case, entry) => {
    language(spelled(entry));

    await expect(host.prepareRename(MODLIST, MARKED)).rejects.toThrow('none is here.');
    await host.rename(MODLIST, MARKED, 'Renamed');
    expect(renamed()).toEqual([]);
  });

  it('offers nothing where no owner names an entry', async () => {
    language(undefined);

    await expect(host.prepareRename(MODLIST, MARKED)).rejects.toThrow('none is here.');
  });

  it('refuses a mod no row lists, and renames nothing', async () => {
    language(spelled(mod('Gone Mod')));

    await expect(host.rename(MODLIST, MARKED, 'Renamed')).rejects.toThrow('Mods lists no mod named Gone Mod.');
    expect(renamed()).toEqual([]);
  });
});

describe('where a mod, a separator, a downloaded file or a profile is defined (symbols.md, The symbols)', () => {
  it.each<[string, EntrySymbol, object, Options?]>([
    ['is a mod\'s row in Mods, by the name as the instance spells it', mod('base mod'), { row: 'Mods' }],
    ['is a separator\'s row in Mods', separator('gear'), { row: 'Mods' }],
    ['is a downloaded file\'s row in Downloads', downloadedFile('patch-1.7z'), { row: 'Downloads' }],
    ['is a mod\'s folder when Mods shows no row for it', mod('Base Mod'), { file: '/instance/mods/Base Mod' }, { shown: false }],
    ['refuses a mod no row lists', mod('Gone Mod'), { refused: 'Mods lists no mod named Gone Mod.' }],
    ['refuses a mod with neither a row nor a folder', mod('Other Mod'), { refused: 'Mods shows no row for it and no folder holds it.' }],
    ['gives a profile no definition', profile('Default'), { none: 'A profile has no definition.' }],
    ['refuses a separator whose row Mods does not show', separator('Gear'), { refused: 'Mods shows no row for it.' }, { shown: false }],
    ['refuses a downloaded file whose row Downloads does not show', downloadedFile('Patch-1.7z'), { refused: 'Downloads shows no row for it.' }, { shown: false }],
    ['refuses a separator no row lists', separator('Gone'), { refused: 'Mods lists no separator named Gone.' }],
    ['refuses a downloaded file no row lists', downloadedFile('Gone.7z'), { refused: 'Downloads lists no downloaded file named Gone.7z.' }],
    ['refuses a profile the instance does not hold', profile('Gone'), { refused: 'The instance holds no profile named Gone.' }],
  ])('%s', async (_case, entry, expected, options) => {
    expect(await language(undefined, options).symbols.definitionOf(entry)).toEqual(expected);
  });
});

describe('the places files name a mod, a separator, a downloaded file or a profile (symbols.md, The features, story 2)', () => {
  it('lists each place the owners report, naming each file they could not read', async () => {
    expect(await language(undefined, { leftOut: [UNREAD] }).symbols.referencesTo(profile('armor test'))).toEqual({ references: [place(MODLIST, 1)], leftOut: [UNREAD] });
  });

  it.each([
    ['a separator', separator('Gear')], ['a downloaded file, whatever its case', downloadedFile('patch-1.7z')],
  ])('lists the places of %s too', async (_case, entry) => {
    expect(await language(undefined).symbols.referencesTo(entry)).toEqual({ references: [place(MODLIST, 1)], leftOut: [] });
  });

  it('refuses to list what names one nothing has the name of, and asks no owner', async () => {
    const { reads, symbols } = language(undefined);

    expect(await symbols.referencesTo(mod('Gone Mod'))).toEqual({ refused: 'Mods lists no mod named Gone Mod.' });
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('hover and completion on a mod, a separator, a downloaded file or a profile (symbols.md, The features, stories 3 and 5)', () => {
  const hovered = async (entry: EntrySymbol, options: Options = {}) => { language(spelled(entry), options); return host.hover(MODLIST, MARKED); };

  it.each([
    ['the row\'s tooltip, a line to each of its lines', mod('base mod'), 'Base Mod · 1.0\nbuilt from source/Base Mod', 'Base Mod · 1.0\n\nbuilt from source/Base Mod'],
    ['none when its row shows no tooltip, as a separator\'s does not', separator('Gear'), undefined, 'Gear'],
    ['none when Mods lists no such mod', mod('Gone Mod'), undefined, 'Gone Mod'],
  ])('its tooltip is %s', async (_case, entry, tooltip, text) => {
    expect(await hovered(entry, { tooltip })).toEqual({ text, spans: 'base mod' });
  });

  it.each([
    ['a downloaded file\'s row\'s, never a mod\'s', downloadedFile('patch-1.7z'), 'Patch-1.7z\n\nsize 1 KB'],
    ['none for a profile, which no row shows, never a mod\'s', profile('Default'), 'Default'],
  ])('its tooltip is %s', async (_case, entry, text) => {
    expect((await hovered(entry, { tooltip: 'a mod\'s tooltip', downloadedFileTooltip: 'Patch-1.7z\nsize 1 KB' }))?.text).toEqual(text);
  });

  it.each([
    ['a mod, every mod', mod('Base'), ['Base Mod', 'Other Mod'], CompletionItemKind.Folder],
    ['a separator, every separator', separator('Gea'), ['Gear'], CompletionItemKind.Folder],
    ['a downloaded file, every downloaded file', downloadedFile('P'), ['Patch-1.7z', 'Armor-2.zip'], CompletionItemKind.File],
    ['a profile, every profile', profile('D'), ['Default', 'Armor Test'], CompletionItemKind.Folder],
  ])('completes where a file names %s, over the name so far', async (_case, entry, items, kind) => {
    language(spelled(entry));

    expect(await host.complete(MODLIST, MARKED)).toEqual({ isIncomplete: false, items: items.map((label) => ({ label, detail: undefined, kind, insertText: undefined, replaces: 'base mod' })) });
  });
});

describe('Go to Symbol in Workspace on a mod, a separator, a downloaded file or a profile (symbols.md, The features, story 4)', () => {
  const names = async (query: string) => (await host.workspaceSymbols(query)).map(({ name, containerName }) => [containerName, name]);
  const locations = async (query: string) => (await host.workspaceSymbols(query)).map(({ location }) => location);

  it('lists each mod and separator whose name holds the query, whatever the case, at the first place a file names it', async () => {
    language(undefined);

    expect(await names('ge')).toEqual([['mod separator', 'Gear']]);
    expect(await names('MOD')).toEqual([['mod', 'Base Mod'], ['mod', 'Other Mod']]);
  });

  it('places an entry its owners\' list names at its line there, and asks the owners for no other entry than one the list leaves out', async () => {
    const { reads } = language(undefined, { listed: [{ entry: mod('base mod'), place: place(MODLIST, 4) }, { entry: separator('Gear'), place: place(MODLIST, 5) }] });

    const found = await host.workspaceSymbols('mod');

    expect(found.map(({ name, containerName, location }) => [containerName, name, location])).toEqual([['mod', 'Base Mod', locationAt(4)], ['mod', 'Other Mod', locationAt(1)]]);
    expect(reads.mock.calls).toEqual([[mod('Other Mod')]]);
  });

  it('places a downloaded file at its own file and a profile at its mod order file, even where no file names them, reading no file', async () => {
    const { reads } = language(undefined, { places: [] });

    expect(await names('ARMOR')).toEqual([['downloaded file', 'Armor-2.zip'], ['profile', 'Armor Test']]);
    expect(await locations('ARMOR')).toEqual([
      new Location(Uri.file(downloadedFileRowFixture('Armor-2.zip').path), new Range(0, 0, 0, 0)), new Location(Uri.file('/profiles/Armor Test/modlist.txt'), new Range(0, 0, 0, 0)),
    ]);
    expect(reads).not.toHaveBeenCalled();
  });

  it('reads nothing for entries a broad query matches when the list names every one', async () => {
    const listed = [mod('Base Mod'), mod('Other Mod'), separator('Gear'), downloadedFile('Patch-1.7z'), downloadedFile('Armor-2.zip'), profile('Default'), profile('Armor Test')];
    const { reads } = language(undefined, { listed: listed.map((entry, line) => ({ entry, place: place(MODLIST, line) })) });

    expect(await host.workspaceSymbols('e')).toHaveLength(5);
    expect(reads).not.toHaveBeenCalled();
  });

  it('says in the Output why a list could not be read, and asks the owners for each entry instead', async () => {
    const { reads, reporter } = language(undefined, { listedFails: true });

    expect(await names('gear')).toEqual([['mod separator', 'Gear']]);
    expect([reads.mock.calls, reporter.shownFailures.map(({ severity, detail }) => [severity, detail])]).toEqual([[[separator('Gear')]], [['warning', 'the list is gone']]]);
  });

  it('lists no entry that no file names', async () => {
    language(undefined, { places: [] });

    expect(await host.workspaceSymbols('mod')).toEqual([]);
  });

  it('selects a mod\'s row in Mods when the user picks it, as its definition is', async () => {
    SHOW_BASE_MOD.mockClear();
    language(undefined);
    const [picked] = await host.workspaceSymbols('base');

    const resolved = picked && await host.resolveWorkspaceSymbol(picked);

    expect([resolved?.location, SHOW_BASE_MOD.mock.calls]).toEqual([locationAt(1), [[]]]);
  });
});

describe('referenced by on a mod (commands.md, `referenced by` under Symbol)', () => {
  it.each<[string, object, string, string]>([
    ['a mod', { argument: mod('Base Mod') }, 'Base Mod', 'modbench.modReferencedBy'],
    ['a separator', { argument: { kind: 'separator', name: 'Gear' } }, 'Gear', 'modbench.separatorReferencedBy'],
  ])('lists the places the owners report for %s, titled with its name', async (_what, row, name, contextValue) => {
    language(undefined);

    await host.run('modbench.symbol.referencedBy', row);

    expect(host.referencesShown).toEqual([expect.objectContaining({ title: `Referenced By: ${name}`, contextValue, location: locationAt(1) })]);
  });
});
