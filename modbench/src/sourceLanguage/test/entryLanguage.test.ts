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
import type { EntryNames, EntrySymbol, PlaceInFile } from '../../symbolNames/symbolNames';
import { recordingReporter } from '../../test/surfacingDoubles';

const MODLIST = '/profiles/Default/modlist.txt';
const UNREAD = '/profiles/Other/modlist.txt: it does not read';
const place = (file: string, line: number): PlaceInFile => ({ file, start: { line, character: 1 }, end: { line, character: 9 } });
const document = { uri: Uri.file(MODLIST), getText: () => '# list\nbase mod\n' };
const AT_NAME = 10;
const mod = (name: string): EntrySymbol => ({ kind: 'mod', name });
const separator = (name: string): EntrySymbol => ({ kind: 'separator', name });

const owner = (named: EntrySymbol | undefined, places: PlaceInFile[] = [place(MODLIST, 1)], leftOut: string[] = []): EntryNames => ({
  read: () => Promise.resolve({ references: places, leftOut }),
  nameAt: () => Promise.resolve(named),
});

function language(named: EntrySymbol | undefined, options: { places?: PlaceInFile[]; leftOut?: string[]; tooltip?: string } = {}) {
  const reporter = recordingReporter();
  const goTo = vi.fn(() => Promise.resolve());
  const mods = [
    { kind: 'mod' as const, name: 'Base Mod', enabled: true }, { kind: 'mod' as const, name: 'Other Mod', enabled: true },
    { kind: 'separator' as const, name: 'Gear', enabled: true },
  ];
  return {
    goTo, reporter,
    ...entryLanguage({ instance: { value: { mods } }, reporter, owners: [owner(named, options.places, options.leftOut)], goTo, tooltip: () => options.tooltip }),
  };
}

describe('Go to Definition on a mod\'s name is the mod\'s go to (symbols.md, The symbols)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it('goes to the mod the name under the place spells, as the instance names it, and answers the name\'s own span', async () => {
    const { definitionAt, goTo } = language(mod('base mod'));

    expect(await definitionAt(document, AT_NAME)).toEqual({ start: 7, end: 15, resolved: true });
    expect(goTo).toHaveBeenCalledWith('Base Mod');
  });

  it('says in the Output, and goes nowhere, when no mod has the name', async () => {
    const { definitionAt, goTo, reporter } = language(mod('Gone Mod'));

    expect((await definitionAt({ uri: document.uri, getText: () => 'Gone Mod\n' }, 3))?.resolved).toBe(false);
    expect([goTo.mock.calls, reporter.shownFailures.map(({ severity }) => severity)]).toEqual([[], ['warning']]);
  });

  it('has no definition for a separator, which goes nowhere and says nothing', async () => {
    const { definitionAt, goTo, reporter } = language(separator('Gear'));

    expect(await definitionAt({ uri: document.uri, getText: () => 'Gear\n' }, 2)).toBeUndefined();
    expect([goTo.mock.calls, reporter.shownFailures]).toEqual([[], []]);
  });

  it('answers where no entry is named, so another feature may', async () => {
    expect(await language(undefined).definitionAt(document, AT_NAME)).toBeUndefined();
  });
});

describe('Find All References on a mod or a separator (symbols.md, The features, story 2)', () => {
  it('lists each place the owners report, and a line in the Output, not a notification, for a file they could not read', async () => {
    const { referencesAt, reporter } = language(mod('Base Mod'), { leftOut: [UNREAD] });

    const found = await referencesAt(document, AT_NAME);

    expect(found).toHaveLength(1);
    expect([reporter.reports, reporter.shownFailures.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['warning', UNREAD]]]);
  });

  it('lists a separator\'s places too', async () => {
    expect(await language(separator('Gear')).referencesAt({ uri: document.uri, getText: () => 'Gear\n' }, 2)).toHaveLength(1);
  });

  it('says in the Output that no entry has the name, and lists nothing', async () => {
    const { referencesAt, reporter } = language(separator('Gone'));

    expect(await referencesAt({ uri: document.uri, getText: () => 'Gone\n' }, 2)).toEqual([]);
    expect(reporter.shownFailures.map(({ severity }) => severity)).toEqual(['warning']);
  });

  it('answers where no entry is named, so another feature may', async () => {
    expect(await language(undefined).referencesAt(document, AT_NAME)).toBeUndefined();
  });
});

describe('hover, completion and Go to Symbol on a mod or a separator (symbols.md, The features, stories 3 to 5)', () => {
  it('hovers with the row\'s tooltip, over the name as the file spells it', async () => {
    const { hoverAt } = language(mod('base mod'), { tooltip: 'Base Mod · 1.0\nbuilt from source/Base Mod' });

    expect(await hoverAt(document, AT_NAME)).toEqual({ start: 7, end: 15, lines: ['Base Mod · 1.0', 'built from source/Base Mod'] });
  });

  it('hovers with the name alone when its row shows no tooltip, as a separator\'s does not', async () => {
    expect((await language(separator('Gear')).hoverAt({ uri: document.uri, getText: () => 'Gear\n' }, 2))?.lines).toEqual(['Gear']);
    expect((await language(mod('Gone Mod')).hoverAt({ uri: document.uri, getText: () => 'Gone Mod\n' }, 2))?.lines).toEqual(['Gone Mod']);
  });

  it('completes where a file names a mod with every mod, and where it names a separator with every separator', async () => {
    expect((await language(mod('Base')).completionsAt(document, AT_NAME))?.items).toEqual(['Base Mod', 'Other Mod']);
    expect((await language(separator('Gea')).completionsAt({ uri: document.uri, getText: () => 'Gea\n' }, 2))?.items).toEqual(['Gear']);
  });

  it('answers where no entry is named, so another feature may', async () => {
    const { hoverAt, completionsAt } = language(undefined);

    expect([await hoverAt(document, AT_NAME), await completionsAt(document, AT_NAME)]).toEqual([undefined, undefined]);
  });

  it('lists each mod and separator whose name holds the query, whatever the case, at the first place a file names it', async () => {
    const { symbolsFor } = language(undefined);

    expect((await symbolsFor('  ge ')).map(({ entry }) => entry)).toEqual([separator('Gear')]);
    expect((await symbolsFor('MOD')).map(({ entry }) => entry)).toEqual([mod('Base Mod'), mod('Other Mod')]);
    expect(await symbolsFor(' ')).toEqual([]);
  });

  it('lists no entry that no file names', async () => {
    expect(await language(undefined, { places: [] }).symbolsFor('mod')).toEqual([]);
  });
});

describe('referenced by on a mod (commands.md, `referenced by` under Mod)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it('lists the places in the References view, titled with the mod and anchored at the first, and notifies of a file it could not read', async () => {
    const { referencedBy, reporter } = language(mod('Base Mod'), { leftOut: [UNREAD] });

    await referencedBy('Base Mod');

    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({ title: 'Referenced By: Base Mod' }));
    expect(reporter.reports.map(({ severity, detail }) => [severity, detail])).toEqual([['warning', UNREAD]]);
  });

  it('says that no file names the mod, which leaves the view where it was', async () => {
    const { referencedBy, reporter } = language(mod('Base Mod'), { places: [] });

    await referencedBy('Base Mod');

    expect([setInput.mock.calls, reporter.reports.map(({ severity }) => severity)]).toEqual([[], ['error']]);
  });
});
