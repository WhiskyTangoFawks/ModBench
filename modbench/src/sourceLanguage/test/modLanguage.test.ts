import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const setInput = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  workspace: { textDocuments: [] },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
}));

import { modLanguage } from '../modLanguage';
import type { ModNames, PlaceInFile } from '../../symbolNames/symbolNames';
import { recordingReporter } from '../../test/surfacingDoubles';

const MODLIST = '/profiles/Default/modlist.txt';
const UNREAD = '/profiles/Other/modlist.txt: it does not read';
const place = (file: string, line: number): PlaceInFile => ({ file, start: { line, character: 1 }, end: { line, character: 9 } });
const document = { uri: Uri.file(MODLIST), getText: () => '# list\nbase mod\n' };
const AT_NAME = 10;

const owner = (named: string | undefined, places: PlaceInFile[] = [place(MODLIST, 1)], leftOut: string[] = []): ModNames => ({
  read: () => Promise.resolve({ references: places, leftOut }),
  nameAt: () => Promise.resolve(named),
});

function language(named: string | undefined, options: { places?: PlaceInFile[]; leftOut?: string[] } = {}) {
  const reporter = recordingReporter();
  const goTo = vi.fn(() => Promise.resolve());
  const mods = [{ kind: 'mod' as const, name: 'Base Mod', enabled: true }, { kind: 'separator' as const, name: 'Gear', enabled: true }];
  return { goTo, reporter, ...modLanguage({ instance: { value: { mods } }, reporter, owners: [owner(named, options.places, options.leftOut)], goTo }) };
}

describe('Go to Definition on a mod\'s name is the mod\'s go to (symbols.md, The symbols)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it('goes to the mod the name under the place spells, as the instance names it, and answers the name\'s own span', async () => {
    const { definitionAt, goTo } = language('base mod');

    expect(await definitionAt(document, AT_NAME)).toEqual({ start: 7, end: 15, resolved: true });
    expect(goTo).toHaveBeenCalledWith('Base Mod');
  });

  it('says in the Output, and goes nowhere, when no mod has the name, and a separator is no mod', async () => {
    for (const name of ['Gone Mod', 'Gear']) {
      const { definitionAt, goTo, reporter } = language(name);

      expect((await definitionAt({ uri: document.uri, getText: () => `${name}\n` }, 3))?.resolved).toBe(false);
      expect([goTo.mock.calls, reporter.shownFailures.map(({ severity }) => severity)]).toEqual([[], ['warning']]);
    }
  });

  it('answers where no mod is named, so another feature may', async () => {
    expect(await language(undefined).definitionAt(document, AT_NAME)).toBeUndefined();
  });
});

describe('Find All References on a mod (symbols.md, The features, story 2)', () => {
  it('lists each place the owners report, and a line in the Output, not a notification, for a file they could not read', async () => {
    const { referencesAt, reporter } = language('Base Mod', { leftOut: [UNREAD] });

    const found = await referencesAt(document, AT_NAME);

    expect(found).toHaveLength(1);
    expect([reporter.reports, reporter.shownFailures.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['warning', UNREAD]]]);
  });

  it('answers where no mod is named, so another feature may', async () => {
    expect(await language(undefined).referencesAt(document, AT_NAME)).toBeUndefined();
  });
});

describe('referenced by on a mod (commands.md, `referenced by` under Mod)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it('lists the places in the References view, titled with the mod and anchored at the first, and notifies of a file it could not read', async () => {
    const { referencedBy, reporter } = language('Base Mod', { leftOut: [UNREAD] });

    await referencedBy('Base Mod');

    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({ title: 'Referenced By: Base Mod' }));
    expect(reporter.reports.map(({ severity, detail }) => [severity, detail])).toEqual([['warning', UNREAD]]);
  });

  it('says that no file names the mod, which leaves the view where it was', async () => {
    const { referencedBy, reporter } = language('Base Mod', { places: [] });

    await referencedBy('Base Mod');

    expect([setInput.mock.calls, reporter.reports.map(({ severity }) => severity)]).toEqual([[], ['error']]);
  });
});
