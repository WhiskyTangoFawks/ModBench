import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const setInput = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  workspace: { textDocuments: [] },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
}));

import { entryLanguage } from '../entryLanguage';
import type { EntryNames, EntryNamed, EntryPlace, EntrySymbol, PlaceInFile } from '../../symbolNames/symbolNames';
import { recordingReporter } from '../../test/surfacingDoubles';

const MODLIST = '/profiles/Default/modlist.txt';
const UNREAD = '/profiles/Other/modlist.txt: it does not read';
const place = (file: string, line: number): PlaceInFile => ({ file, start: { line, character: 1 }, end: { line, character: 9 } });
const document = { uri: Uri.file(MODLIST), getText: () => '# list\nbase mod\n' };
const AT_NAME = 10;
const mod = (name: string): EntrySymbol => ({ kind: 'mod', name });
const separator = (name: string): EntrySymbol => ({ kind: 'separator', name });
const downloadedFile = (name: string): EntrySymbol => ({ kind: 'downloadedFile', name });
const profile = (name: string): EntrySymbol => ({ kind: 'profile', name });
const row = (name: string) => ({
  name, displayName: name, status: 'Downloaded' as const, size: 0, mtimeMs: 0, hasMeta: false, excluded: false, upgrades: [], path: `/downloads/${name}`, metadataPath: '',
});
const spelled = (entry: EntrySymbol): EntryNamed => ({ entry, start: 7, end: 15 });
const SPAN = { start: 7, end: 15 };
const locationAt = (line: number) => ({ uri: Uri.file(MODLIST), range: new Range(line, 1, line, 9) });
const located = (found: readonly { uri: unknown; range: unknown }[] | undefined) => found?.map(({ uri, range }) => ({ uri, range }));

interface Options {
  places?: PlaceInFile[];
  leftOut?: string[];
  tooltip?: string;
  downloadedFileTooltip?: string;
  listed?: EntryPlace[];
  listedFails?: boolean;
}

function language(named: EntryNamed | undefined, options: Options = {}) {
  const reporter = recordingReporter();
  const goTo = vi.fn((_mod: string) => Promise.resolve());
  const reads = vi.fn();
  const listings = vi.fn();
  const owner: EntryNames = {
    listed: (kind) => {
      listings(kind);
      return options.listedFails ? Promise.reject(new Error('the list is gone')) : Promise.resolve((options.listed ?? []).filter(({ entry }) => entry.kind === kind));
    },
    read: (entry) => { reads(entry); return Promise.resolve({ references: options.places ?? [place(MODLIST, 1)], leftOut: options.leftOut ?? [] }); },
    nameAt: () => Promise.resolve(named),
  };
  const mods = [
    { kind: 'mod' as const, name: 'Base Mod', enabled: true }, { kind: 'mod' as const, name: 'Other Mod', enabled: true },
    { kind: 'separator' as const, name: 'Gear', enabled: true },
  ];
  const value = { mods, downloadedFiles: { kind: 'listed' as const, rows: [row('Patch-1.7z'), row('Armor-2.zip')] }, profiles: ['Default', 'Armor Test'] };
  return { goTo, reporter, reads, listings, ...entryLanguage({
    instance: { value }, reporter, owners: [owner], goTo, entryTooltip: () => options.tooltip, downloadedFileTooltip: () => options.downloadedFileTooltip,
  }) };
}

describe('Go to Definition on a name of a mod, a separator, a downloaded file or a profile (symbols.md, The symbols)', () => {
  it.each([
    ['goes to the mod, as the instance names it, and answers the name\'s own span', mod('base mod'), { ...SPAN, resolved: true }, ['Base Mod'], []],
    ['says in the Output, and goes nowhere, when no mod has the name', mod('Gone Mod'), { ...SPAN, resolved: false }, [], ['warning']],
    ['has no definition for a separator, which goes nowhere and says nothing', separator('Gear'), undefined, [], []],
    ['has no definition for a downloaded file', downloadedFile('Patch-1.7z'), undefined, [], []],
    ['has no definition for a profile', profile('Default'), undefined, [], []],
  ])('%s', async (_case, entry, expected, goneTo, severities) => {
    const { definitionAt, goTo, reporter } = language(spelled(entry));

    expect(await definitionAt(document, AT_NAME)).toEqual(expected);
    expect([goTo.mock.calls.map(([name]) => name), reporter.shownFailures.map(({ severity }) => severity)]).toEqual([goneTo, severities]);
  });
});

describe('Find All References on a symbol its name alone names (symbols.md, The features, story 2)', () => {
  it('lists each place the owners report, and a line in the Output, not a notification, for a file they could not read', async () => {
    const { referencesAt, reporter } = language(spelled(mod('Base Mod')), { leftOut: [UNREAD] });

    expect(located(await referencesAt(document, AT_NAME))).toEqual([locationAt(1)]);
    expect([reporter.reports, reporter.shownFailures.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['warning', UNREAD]]]);
  });

  it.each([
    ['a separator', separator('Gear')], ['a downloaded file, whatever its case', downloadedFile('patch-1.7z')], ['a profile', profile('Default')],
  ])('lists the places of %s too', async (_case, entry) => {
    expect(located(await language(spelled(entry)).referencesAt(document, AT_NAME))).toEqual([locationAt(1)]);
  });

  it.each([
    [separator('Gone'), 'Mods lists no separator named Gone.'],
    [downloadedFile('Gone.7z'), 'Downloads lists no downloaded file named Gone.7z.'],
    [profile('Gone'), 'The instance holds no profile named Gone.'],
  ])('says in the Output that nothing has the name, and lists nothing: %o', async (entry, detail) => {
    const { referencesAt, reporter } = language(spelled(entry));

    expect(await referencesAt(document, AT_NAME)).toEqual([]);
    expect(reporter.shownFailures.map((failure) => [failure.severity, failure.detail])).toEqual([['warning', detail]]);
  });
});

describe('hover and completion on a symbol its name alone names (symbols.md, The features, stories 3 and 5)', () => {
  it.each([
    ['the row\'s tooltip, a line to each of its lines', mod('base mod'), 'Base Mod · 1.0\nbuilt from source/Base Mod', ['Base Mod · 1.0', 'built from source/Base Mod']],
    ['the name alone when its row shows no tooltip, as a separator\'s does not', separator('Gear'), undefined, ['Gear']],
    ['the name alone when Mods lists no such mod', mod('Gone Mod'), undefined, ['Gone Mod']],
  ])('hover says %s', async (_case, entry, tooltip, lines) => {
    expect(await language(spelled(entry), { tooltip }).hoverAt(document, AT_NAME)).toEqual({ ...SPAN, lines });
  });

  it.each([
    ['a downloaded file\'s row\'s tooltip, never a mod\'s', downloadedFile('patch-1.7z'), ['Patch-1.7z', 'size 1 KB']],
    ['a profile\'s name, which no row shows, never a mod\'s tooltip', profile('Default'), ['Default']],
  ])('hover says %s', async (_case, entry, lines) => {
    const hovered = language(spelled(entry), { tooltip: 'a mod\'s tooltip', downloadedFileTooltip: 'Patch-1.7z\nsize 1 KB' });

    expect(await hovered.hoverAt(document, AT_NAME)).toEqual({ ...SPAN, lines });
  });

  it.each([
    ['a mod, every mod', mod('Base'), ['Base Mod', 'Other Mod']],
    ['a separator, every separator', separator('Gea'), ['Gear']],
    ['a downloaded file, every downloaded file', downloadedFile('P'), ['Patch-1.7z', 'Armor-2.zip']],
    ['a profile, every profile', profile('D'), ['Default', 'Armor Test']],
  ])('completes where a file names %s, over the name so far', async (_case, entry, items) => {
    expect(await language(spelled(entry)).completionsAt(document, AT_NAME)).toEqual({ ...SPAN, kind: entry.kind, items });
  });
});

describe('Go to Symbol in Workspace on a symbol its name alone names (symbols.md, The features, story 4)', () => {
  it('lists each mod and separator whose name holds the query, whatever the case, at the first place a file names it', async () => {
    const { symbolsFor } = language(undefined);

    expect((await symbolsFor('  ge ')).map(({ entry }) => entry)).toEqual([separator('Gear')]);
    expect((await symbolsFor('MOD')).map(({ entry }) => entry)).toEqual([mod('Base Mod'), mod('Other Mod')]);
    expect(await symbolsFor(' ')).toEqual([]);
  });

  it('places an entry its owners\' list names at its line there, and asks the owners for no other entry than one the list leaves out', async () => {
    const { symbolsFor, reads } = language(undefined, { listed: [{ entry: mod('base mod'), place: place(MODLIST, 4) }, { entry: separator('Gear'), place: place(MODLIST, 5) }] });

    const found = await symbolsFor('mod');

    expect(found.map(({ entry }) => entry)).toEqual([mod('Base Mod'), mod('Other Mod')]);
    expect(located(found.map(({ location }) => location))).toEqual([locationAt(4), locationAt(1)]);
    expect(reads.mock.calls).toEqual([[mod('Other Mod')]]);
  });

  it('places a downloaded file or a profile, whatever the case of the query, only where the owners list it, and reads no file for one they leave out', async () => {
    const listed = [{ entry: downloadedFile('armor-2.zip'), place: place(MODLIST, 2) }, { entry: profile('Armor Test'), place: place(MODLIST, 3) }];
    const { symbolsFor, reads } = language(undefined, { listed });

    const found = await symbolsFor('ARMOR');
    const unlisted = await symbolsFor('patch');

    expect(found.map(({ entry }) => entry)).toEqual([downloadedFile('Armor-2.zip'), profile('Armor Test')]);
    expect(located(found.map(({ location }) => location))).toEqual([locationAt(2), locationAt(3)]);
    expect([unlisted, reads.mock.calls]).toEqual([[], []]);
  });

  it('asks the owners for the places of no kind that no name of the query holds', async () => {
    const { symbolsFor, listings } = language(undefined);

    await symbolsFor('patch');

    expect(listings.mock.calls).toEqual([['downloadedFile']]);
  });

  it('reads nothing for entries a broad query matches when the list names every one', async () => {
    const listed = [mod('Base Mod'), mod('Other Mod'), separator('Gear'), downloadedFile('Patch-1.7z'), downloadedFile('Armor-2.zip'), profile('Default'), profile('Armor Test')];
    const { symbolsFor, reads } = language(undefined, { listed: listed.map((entry, line) => ({ entry, place: place(MODLIST, line) })) });

    expect(await symbolsFor('e')).toHaveLength(5);
    expect(reads).not.toHaveBeenCalled();
  });

  it('says in the Output why a list could not be read, and asks the owners for each entry instead', async () => {
    const { symbolsFor, reads, reporter } = language(undefined, { listedFails: true });

    expect((await symbolsFor('gear')).map(({ entry }) => entry)).toEqual([separator('Gear')]);
    expect([reads.mock.calls, reporter.shownFailures.map(({ severity, detail }) => [severity, detail])]).toEqual([[[separator('Gear')]], [['warning', 'the list is gone']]]);
  });

  it('lists no entry that no file names', async () => {
    expect(await language(undefined, { places: [] }).symbolsFor('mod')).toEqual([]);
  });
});

describe('every feature answers where no entry is named, so another feature may', () => {
  const none = language(undefined);

  it.each([
    ['Go to Definition', () => none.definitionAt(document, AT_NAME)],
    ['Find All References', () => none.referencesAt(document, AT_NAME)],
    ['hover', () => none.hoverAt(document, AT_NAME)],
    ['completion', () => none.completionsAt(document, AT_NAME)],
  ])('%s', async (_feature, answer) => {
    expect(await answer()).toBeUndefined();
  });
});

describe('referenced by on a mod (commands.md, `referenced by` under Mod)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it('lists the places in the References view, titled with the mod and anchored at the first, and notifies of a file it could not read', async () => {
    const { referencedBy, reporter } = language(spelled(mod('Base Mod')), { leftOut: [UNREAD] });

    await referencedBy('Base Mod');

    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({ title: 'Referenced By: Base Mod', contextValue: 'modbench.modReferencedBy', location: expect.objectContaining(locationAt(1)) as unknown }));
    expect(reporter.reports.map(({ severity, detail }) => [severity, detail])).toEqual([['warning', UNREAD]]);
  });

  it('says that no file names the mod, which leaves the view where it was', async () => {
    const { referencedBy, reporter } = language(spelled(mod('Base Mod')), { places: [] });

    await referencedBy('Base Mod');

    expect([setInput.mock.calls, reporter.reports.map(({ severity }) => severity)]).toEqual([[], ['error']]);
  });
});
