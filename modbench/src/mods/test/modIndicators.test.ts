import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type * as vscode from 'vscode';
import type { FakeInstance } from '../../test/mo2/fakeInstance';
import { modsViewOn } from './modsViewOn';
import { answers, changeSetting, seen } from './modsVscode';
import type { InstanceValue, OriginFile } from '../../instanceLoader/instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { present } from '../../ports/present';
import { MOD_INDICATORS } from '../modFileStates';
import { modOrigin, type LoadedArchive } from '../../instanceLoader/fileConflictIndex';
import { modArgumentOf, separatorArgumentOf } from '../../drivingLib/argument';
import { FakeCancellationToken, ThemeColor, ThemeIcon, Uri } from '../../test/vscodeMock';
import { file, indexedValueOf, indexedValues, mod } from './indexedValue';

type Shown = ReturnType<typeof modsViewOn<FakeInstance>>;
type Listings = Parameters<typeof indexedValueOf>[1];

const indicatorSetting = (id: string, part: 'badge' | 'colour') => `modbench.mods.indicators.${id}.${part}`;

const shownWith = (value: InstanceValue, on: readonly string[] = MOD_INDICATORS.flatMap(({ id }) => [indicatorSetting(id, 'badge'), indicatorSetting(id, 'colour')])): Shown => {
  const shown = modsViewOn({ value });
  on.forEach((key) => { answers.settings.set(key, true); });
  return shown;
};

const modRowNamed = async ({ rows }: Shown, name: string): Promise<vscode.TreeItem> => {
  const roots = await rows();
  const under = (await Promise.all(roots.filter((row) => separatorArgumentOf(row) !== undefined).map(async (row) => rows(row)))).flat();
  return present([...roots, ...under].find((row) => modArgumentOf(row)?.name === name), `the "${name}" mod row`);
};

const uriOf = (row: vscode.TreeItem): vscode.Uri => present(row.resourceUri, 'the row\'s URI');

const carriedOn = async (shown: Shown, uri: vscode.Uri): Promise<unknown[]> => (await shown.decorationsOf(uri)).map(({ tooltip }) => tooltip);

const carriedBy = async (shown: Shown, name: string): Promise<unknown[]> => carriedOn(shown, uriOf(await modRowNamed(shown, name)));

const toldTheProviderOf = async (indicator: string, uri: vscode.Uri): Promise<unknown[]> => {
  const heard = await Promise.all(seen.decorationProviders.map(async (provider) => {
    const told: unknown[] = [];
    provider.onDidChangeFileDecorations?.((uris) => { told.push(uris); });
    return { tooltip: (await provider.provideFileDecoration(uri, new FakeCancellationToken()))?.tooltip, told };
  }));
  return present(heard.find(({ tooltip }) => tooltip === indicator), `the provider of ${indicator}`).told;
};

describe('the indicators a mod carries as a change reaches it, kept path by path (ADR-0029, Consequences, bullet 5)', () => {
  it('carries Contains excluded files once the mod gains an excluded file, and drops it once the mod loses that file', async () => {
    const next = indexedValues([mod('A')]);
    const kept = file('A', 'a.dds');
    const shown = shownWith(next({ A: { files: [kept] } }));
    const uri = uriOf(await shown.row('A'));
    const before = await carriedOn(shown, uri);

    shown.instance.publish(next({ A: { files: [kept, file('A', 'b.dds', true)] } }));
    const gained = await carriedOn(shown, uri);
    shown.instance.publish(next({ A: { files: [kept] } }));

    expect([before, gained, await carriedOn(shown, uri)]).toEqual([[], ['Contains excluded files'], []]);
  });
});

describe('the indicators each mod carries (mods.md, Indicators)', () => {
  it.each<[string, ModlistEntry[], Listings, OriginFile[], string, string[]]>([
    ['a mod the Instance adapter says has an update carries Update available', [{ ...mod('Patch'), updateAvailable: true }], {}, [], 'Patch', ['Update available']],
    ['a mod the Instance adapter says has no update carries none', [{ ...mod('Current'), updateAvailable: false }], {}, [], 'Current', []],
    ['a mod not checked for an update carries none', [mod('Unchecked')], {}, [], 'Unchecked', []],
    ['a mod with an excluded file contains excluded files, and its excluded copy wins over nothing', [mod('Winner'), mod('Loser')],
      { Winner: { files: [file('Winner', 'a.dds', true), file('Winner', 'own.dds')] }, Loser: { files: [file('Loser', 'a.dds')] } }, [], 'Winner', ['Contains excluded files']],
    ['a mod whose copy loses only to an excluded copy is not overwritten', [mod('Winner'), mod('Loser')],
      { Winner: { files: [file('Winner', 'a.dds', true), file('Winner', 'own.dds')] }, Loser: { files: [file('Loser', 'a.dds')] } }, [], 'Loser', []],
    ['a mod whose every file is excluded has no file the game could get, so is not redundant', [mod('A')],
      { A: { files: [file('A', 'a.dds', true)] } }, [], 'A', ['Contains excluded files']],
    ['a disabled mod carries none', [mod('Winner'), mod('Off', false)],
      { Winner: { files: [file('Winner', 'a.dds')] }, Off: { files: [file('Off', 'a.dds'), file('Off', 'b.dds', true)] } }, [], 'Off', []],
    ['a mod with no files carries none', [mod('Empty')], {}, [], 'Empty', []],
    ['a disabled mod carries none though an enabled separator shares its name', [mod('Winner'), mod('Shared', false), { kind: 'separator', name: 'Shared', enabled: true }],
      { Winner: { files: [file('Winner', 'a.dds')] }, Shared: { files: [file('Shared', 'a.dds'), file('Shared', 'b.dds', true)] } }, [], 'Shared', []],
  ])('%s', async (_case, mods, listings, overwrite, name, carried) => {
    expect(await carriedBy(shownWith(await indexedValueOf(mods, listings, { files: overwrite })), name)).toEqual(carried);
  });

  const archive = (name: string, ...files: string[]): LoadedArchive => ({ origin: modOrigin(name), archive: `/instance/${name}/${name}.ba2`, files });

  it.each<[string, string, LoadedArchive[], OriginFile[]]>([
    ['Overwrites an archive with loose files', 'Loose', [archive('Archived', 'a.nif')], [file('Loose', 'a.nif')]],
    ['Archive is overwritten by loose files', 'Archived', [archive('Archived', 'a.nif', 'own.nif')], [file('Loose', 'a.nif')]],
    ['Overwrites another archive file', 'Winner', [archive('Archived', 'a.nif'), archive('Winner', 'a.nif')], []],
    ['Overwritten by another archive file', 'Archived', [archive('Archived', 'a.nif', 'own.nif'), archive('Winner', 'a.nif')], []],
  ])('%s is carried by the mod that holds it', async (indicator, carrier, loaded, looseFiles) => {
    const value = await indexedValueOf([mod('Loose'), mod('Archived'), mod('Winner')], { Loose: { files: looseFiles } }, { files: [] }, loaded);

    expect(await carriedBy(shownWith(value), carrier)).toEqual([indicator]);
  });
});

const OVERWRITES = { badge: '⊕', color: new ThemeColor('modbench.modOverwritesLooseFiles'), tooltip: 'Overwrites loose files' };

const middleOfThree = () => indexedValueOf([mod('High'), mod('Middle'), mod('Low')], {
  High: { files: [file('High', 'a.dds')] },
  Middle: { files: [file('Middle', 'a.dds'), file('Middle', 'own.dds'), file('Middle', 'b.dds', true)] },
  Low: { files: [file('Low', 'a.dds')] },
});

describe('a mod row\'s indicators, each switched in settings (mods.md, A row, Mod; Indicators)', () => {
  it('carries a badge and a colour for each indicator that holds, its tooltip the indicator\'s name', async () => {
    const shown = shownWith(await middleOfThree());

    expect(await shown.decorationsOf(uriOf(await shown.row('Middle')))).toEqual([
      { badge: '⊕', color: new ThemeColor('modbench.modOverwritesLooseFiles'), tooltip: 'Overwrites loose files' },
      { badge: '⊖', color: new ThemeColor('modbench.modOverwrittenLooseFiles'), tooltip: 'Overwritten loose files' },
      { badge: '⊘', color: new ThemeColor('modbench.modContainsExcludedFiles'), tooltip: 'Contains excluded files' },
    ]);
  });

  it('carries only the parts its settings switch on, and nothing for an indicator with both off', async () => {
    const shown = shownWith(await middleOfThree(), [indicatorSetting('overwritesLooseFiles', 'badge'), indicatorSetting('overwrittenLooseFiles', 'colour')]);

    expect(await shown.decorationsOf(uriOf(await shown.row('Middle')))).toEqual([
      { badge: '⊕', color: undefined, tooltip: 'Overwrites loose files' },
      { badge: undefined, color: new ThemeColor('modbench.modOverwrittenLooseFiles'), tooltip: 'Overwritten loose files' },
    ]);
  });

  it('decorates no mod\'s folder where the Explorer shows it', async () => {
    const shown = shownWith(await middleOfThree());

    expect(await shown.decorationsOf(Uri.file('/instance/Middle'))).toEqual([]);
  });

  it('asks VS Code to decorate again on each new instance value, and answers from that value', async () => {
    const shown = shownWith(await middleOfThree());
    const uri = uriOf(await shown.row('Low'));
    const before = await carriedOn(shown, uri);
    const told = seen.decorationProviders.map((provider) => {
      const heard: unknown[] = [];
      provider.onDidChangeFileDecorations?.((uris) => { heard.push(uris); });
      return heard;
    });

    shown.instance.publish(await indexedValueOf([mod('Low')], { Low: { files: [file('Low', 'a.dds')] } }));

    const theGreyAndEachIndicator = [[undefined], ...MOD_INDICATORS.map(() => [undefined])];
    expect([before, told, await carriedOn(shown, uri)]).toEqual([['Redundant'], theGreyAndEachIndicator, []]);
  });

  it('asks VS Code to decorate again only for the indicator whose setting changed', async () => {
    const shown = shownWith(await middleOfThree());
    const redundant = await toldTheProviderOf('Redundant', uriOf(await shown.row('Low')));
    const overwrites = await toldTheProviderOf('Overwrites loose files', uriOf(await shown.row('Middle')));

    changeSetting('modbench.something', true);
    changeSetting(indicatorSetting('redundant', 'colour'), true);

    expect([redundant, overwrites]).toEqual([[undefined], []]);
  });
});

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

const groupedMiddleOfThree = () => indexedValueOf([mod('High'), mod('Middle'), mod('Low'), separator('Section'), mod('Alone'), separator('Quiet')], {
  High: { files: [file('High', 'a.dds')] },
  Middle: { files: [file('Middle', 'a.dds'), file('Middle', 'own.dds'), file('Middle', 'b.dds', true)] },
  Low: { files: [file('Low', 'a.dds')] },
  Alone: { files: [file('Alone', 'only.dds')] },
});

describe('a collapsed separator\'s indicators (common.md, Chrome, story 11)', () => {
  const grouped = async (on?: readonly string[]) => {
    const shown = shownWith(await groupedMiddleOfThree(), on);
    const section = await shown.row('Section');
    return { ...shown, section, sectionUri: uriOf(section) };
  };

  it('carries the indicators of the mods beneath it as a mod row carries its own', async () => {
    const { decorationsOf, sectionUri } = await grouped();

    expect(await decorationsOf(sectionUri)).toEqual([
      { badge: '⊕', color: new ThemeColor('modbench.modOverwritesLooseFiles'), tooltip: 'Overwrites loose files' },
      { badge: '⊖', color: new ThemeColor('modbench.modOverwrittenLooseFiles'), tooltip: 'Overwritten loose files' },
      { badge: '⊗', color: new ThemeColor('modbench.modRedundant'), tooltip: 'Redundant' },
      { badge: '⊘', color: new ThemeColor('modbench.modContainsExcludedFiles'), tooltip: 'Contains excluded files' },
    ]);
  });

  it('carries only the parts its settings switch on', async () => {
    const { decorationsOf, sectionUri } = await grouped([indicatorSetting('overwritesLooseFiles', 'badge')]);

    expect(await decorationsOf(sectionUri)).toEqual([{ badge: '⊕', color: undefined, tooltip: 'Overwrites loose files' }]);
  });

  it('carries none when no mod beneath holds one', async () => {
    const shown = await grouped();

    expect(await shown.decorationsOf(uriOf(await shown.row('Quiet')))).toEqual([]);
  });

  it('carries none while it is expanded, and again once it collapses', async () => {
    const { view, section, sectionUri, decorationsOf } = await grouped();
    const told = await toldTheProviderOf('Overwrites loose files', sectionUri);

    view.expand(section);
    const expanded = await decorationsOf(sectionUri);
    view.collapse(section);

    expect([expanded, (await decorationsOf(sectionUri))[0], told]).toEqual([[], OVERWRITES, [undefined, undefined]]);
  });

  it('leaves an open mod row its own indicators', async () => {
    const { view, row, section, decorationsOf } = await grouped();
    const middle = await row('Middle', section);

    view.expand(middle);

    expect((await decorationsOf(uriOf(middle)))[0]).toEqual(OVERWRITES);
  });

  it('forgets a separator that left the list, so one added later under its name starts collapsed', async () => {
    const { view, section, sectionUri, decorationsOf, instance } = await grouped();
    view.expand(section);

    instance.publish(await indexedValueOf([mod('Low')], { Low: { files: [file('Low', 'a.dds')] } }));
    instance.publish(await groupedMiddleOfThree());

    expect((await decorationsOf(sectionUri))[0]).toEqual(OVERWRITES);
  });

  it('forgets a separator emptied while open, so one refilled starts collapsed', async () => {
    const { view, section, sectionUri, decorationsOf, instance } = await grouped();
    view.expand(section);

    instance.publish(await indexedValueOf([separator('Section')], {}));
    instance.publish(await groupedMiddleOfThree());

    expect((await decorationsOf(sectionUri))[0]).toEqual(OVERWRITES);
  });
});

describe('a separator row (mods.md, A row, Separator)', () => {
  it('has the URI its indicators are drawn on, and no icon from the file icon theme', async () => {
    const shown = shownWith(await groupedMiddleOfThree());
    const section = await shown.row('Section');

    expect([(await shown.decorationsOf(uriOf(section)))[0], section.iconPath]).toEqual([OVERWRITES, new ThemeIcon('blank')]);
  });
});

describe('the rows a change to some mods\' files touches (common.md, A view, story 13)', () => {
  type Change = { listings: Listings; overwrite: OriginFile[] };

  const unchangedLow = { files: [file('Low', 'a.dds')] };
  const unchangedZ = { files: [file('Z', 'q.dds')] };
  it.each<[string, ModlistEntry[], Change, Change, string]>([
    ['a mod above it gains a copy of its only file', [mod('High'), mod('Low')],
      { listings: { High: { files: [file('High', 'own.dds')] }, Low: unchangedLow }, overwrite: [] },
      { listings: { High: { files: [file('High', 'own.dds'), file('High', 'a.dds')] }, Low: unchangedLow }, overwrite: [] }, 'Low'],
    ['Overwrite gains a copy of its only file while another mod gains a file', [mod('Z'), mod('M')],
      { listings: { Z: unchangedZ, M: { files: [file('M', 'm.dds')] } }, overwrite: [] },
      { listings: { Z: unchangedZ, M: { files: [file('M', 'm.dds'), file('M', 'm2.dds')] } }, overwrite: [file('overwrite', 'q.dds')] }, 'Z'],
  ])('shows a mod Redundant once %s', async (_case, mods, was, now, name) => {
    const before = await indexedValueOf(mods, was.listings, { files: was.overwrite });
    const shown = shownWith(before);
    const uri = uriOf(await shown.row(name));
    await carriedOn(shown, uri);
    const after = await indexedValueOf(mods, now.listings, { files: now.overwrite });

    shown.instance.publish({ ...before, ...(({ files, filesByMod, foldersByMod, stackedCopies, overwriteFiles }) => ({ files, filesByMod, foldersByMod, stackedCopies, overwriteFiles }))(after) });

    expect(await carriedOn(shown, uri)).toEqual(['Redundant']);
  });
});
