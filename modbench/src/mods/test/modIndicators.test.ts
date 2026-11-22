import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri,
}));

import * as vscode from 'vscode';
import type { InstanceValue, OriginFile } from '../../instanceLoader/instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { present } from '../../ports/present';
import { ModListProvider, ModNode, SeparatorNode } from '../ModListProvider';
import { OpenRows } from '../openRows';
import { NO_MOD_STATUSES } from '../../test/noModStatuses';
import { MOD_INDICATORS } from '../modFileStates';
import { modOrigin, type LoadedArchive } from '../../instanceLoader/fileConflictIndex';
import { indicatorSetting, ModIndicatorDecorations, modRowUri, separatorRowUri } from '../modIndicators';
import { file, indexedValueOf, indexedValues, mod } from './indexedValue';
import { recordingReporter } from '../../test/surfacingDoubles';

type ModIndicator = (typeof MOD_INDICATORS)[number]['id'];

const carriedBy = (value: InstanceValue, name: string): ModIndicator[] =>
  decorationsOn(decoratedOver(new FakeInstance(value), settingsOf(allOn).settings), modRowUri(name))
    .flatMap((decoration, at) => (decoration === undefined ? [] : [present(MOD_INDICATORS[at], 'an indicator').id]));

const decoratedOver = (instance: FakeInstance, settings: ReturnType<typeof settingsOf>['settings']) => {
  const open = new OpenRows(instance);
  return Object.assign(new ModIndicatorDecorations(instance, open, settings), { open });
};

type Listings = Parameters<typeof indexedValueOf>[1];

describe('the indicators a mod carries as a change reaches it, kept path by path (ADR-0029, Consequences, bullet 5)', () => {
  it('carries Contains excluded files once the mod gains an excluded file, and drops it once the mod loses that file', () => {
    const next = indexedValues([mod('A')]);
    const kept = file('A', 'a.dds');
    const instance = new FakeInstance(next({ A: { files: [kept] } }));
    const decorations = decoratedOver(instance, settingsOf(allOn).settings);
    const excluded = () => decorationsOn(decorations, modRowUri('A'))[MOD_INDICATORS.findIndex(({ id }) => id === 'containsExcludedFiles')] !== undefined;
    const carried: boolean[] = [excluded()];

    instance.publish(next({ A: { files: [kept, file('A', 'b.dds', true)] } }));
    carried.push(excluded());
    instance.publish(next({ A: { files: [kept] } }));
    carried.push(excluded());

    expect(carried).toEqual([false, true, false]);
  });
});

describe('the indicators each mod carries (mods.md, Indicators)', () => {
  it.each<[string, ModlistEntry[], Listings, OriginFile[], string, ModIndicator[]]>([
    ['a mod the Instance adapter says has an update carries Update available', [{ ...mod('Patch'), updateAvailable: true }], {}, [], 'Patch', ['updateAvailable']],
    ['a mod the Instance adapter says has no update carries none', [{ ...mod('Current'), updateAvailable: false }], {}, [], 'Current', []],
    ['a mod not checked for an update carries none', [mod('Unchecked')], {}, [], 'Unchecked', []],
    ['a mod with an excluded file contains excluded files, and its excluded copy wins over nothing', [mod('Winner'), mod('Loser')],
      { Winner: { files: [file('Winner', 'a.dds', true), file('Winner', 'own.dds')] }, Loser: { files: [file('Loser', 'a.dds')] } }, [], 'Winner', ['containsExcludedFiles']],
    ['a mod whose copy loses only to an excluded copy is not overwritten', [mod('Winner'), mod('Loser')],
      { Winner: { files: [file('Winner', 'a.dds', true), file('Winner', 'own.dds')] }, Loser: { files: [file('Loser', 'a.dds')] } }, [], 'Loser', []],
    ['a mod whose every file is excluded has no file the game could get, so is not redundant', [mod('A')],
      { A: { files: [file('A', 'a.dds', true)] } }, [], 'A', ['containsExcludedFiles']],
    ['a disabled mod carries none', [mod('Winner'), mod('Off', false)],
      { Winner: { files: [file('Winner', 'a.dds')] }, Off: { files: [file('Off', 'a.dds'), file('Off', 'b.dds', true)] } }, [], 'Off', []],
    ['a mod with no files carries none', [mod('Empty')], {}, [], 'Empty', []],
    ['a disabled mod carries none though an enabled separator shares its name', [mod('Winner'), mod('Shared', false), { kind: 'separator', name: 'Shared', enabled: true }],
      { Winner: { files: [file('Winner', 'a.dds')] }, Shared: { files: [file('Shared', 'a.dds'), file('Shared', 'b.dds', true)] } }, [], 'Shared', []],
  ])('%s', async (_case, mods, listings, overwrite, name, carried) => {
    expect(carriedBy(await indexedValueOf(mods, listings, { files: overwrite }), name)).toEqual(carried);
  });

  const archive = (name: string, ...files: string[]): LoadedArchive => ({ origin: modOrigin(name), archive: `/instance/${name}/${name}.ba2`, files });

  it.each<[string, string, LoadedArchive[], OriginFile[], ModIndicator]>([
    ['Overwrites an archive with loose files', 'Loose', [archive('Archived', 'a.nif')], [file('Loose', 'a.nif')], 'overwritesArchiveWithLooseFiles'],
    ['Archive is overwritten by loose files', 'Archived', [archive('Archived', 'a.nif', 'own.nif')], [file('Loose', 'a.nif')], 'archiveOverwrittenByLooseFiles'],
    ['Overwrites another archive file', 'Winner', [archive('Archived', 'a.nif'), archive('Winner', 'a.nif')], [], 'overwritesAnotherArchiveFile'],
    ['Overwritten by another archive file', 'Archived', [archive('Archived', 'a.nif', 'own.nif'), archive('Winner', 'a.nif')], [], 'overwrittenByAnotherArchiveFile'],
  ])('%s is carried by the mod that holds it', async (_indicator, carrier, loaded, looseFiles, carried) => {
    const value = await indexedValueOf([mod('Loose'), mod('Archived'), mod('Winner')], { Loose: { files: looseFiles } }, { files: [] }, loaded);

    expect(carriedBy(value, carrier)).toEqual([carried]);
  });
});

const settingsOf = (on: Partial<Record<string, boolean>>) => {
  const changed = new EventEmitter<{ affectsConfiguration: (key: string) => boolean }>();
  return {
    changed,
    settings: { getConfiguration: () => ({ get: (key: string) => on[key] }), onDidChangeConfiguration: changed.event },
  };
};

const allOn = Object.fromEntries(MOD_INDICATORS
  .flatMap(({ id }) => [[indicatorSetting(id, 'badge'), true], [indicatorSetting(id, 'colour'), true]]));

async function rowUriOf(instance: FakeInstance, name: string): Promise<vscode.Uri> {
  const rows = new ModListProvider({ reporter: recordingReporter(), statuses: NO_MOD_STATUSES, instance, open: new OpenRows(instance) });
  const row = (await rows.getChildren()).find((node) => node instanceof ModNode && node.mod.name === name);
  return present(row?.resourceUri, `${name}'s row URI`);
}

const undecorated = Array.from({ length: MOD_INDICATORS.length }, () => undefined);

const OVERWRITES = { badge: '\u2295', color: new ThemeColor('modbench.modOverwritesLooseFiles'), tooltip: 'Overwrites loose files' };
const REDUNDANT = { badge: '\u2297', color: new ThemeColor('modbench.modRedundant'), tooltip: 'Redundant' };

const decorationsOn = (decorations: ModIndicatorDecorations, uri: vscode.Uri) =>
  decorations.providers.map((provider) => provider.provideFileDecoration(uri));

const middleOfThree = () => indexedValueOf([mod('High'), mod('Middle'), mod('Low')], {
  High: { files: [file('High', 'a.dds')] },
  Middle: { files: [file('Middle', 'a.dds'), file('Middle', 'own.dds'), file('Middle', 'b.dds', true)] },
  Low: { files: [file('Low', 'a.dds')] },
});

describe('a mod row\'s indicators, each switched in settings (mods.md, A row, Mod; Indicators)', () => {
  it('carries a badge and a colour for each indicator that holds, its tooltip the indicator\'s name', async () => {
    const instance = new FakeInstance(await middleOfThree());
    const decorations = decoratedOver(instance, settingsOf(allOn).settings);

    expect(decorationsOn(decorations, await rowUriOf(instance, 'Middle'))).toEqual([
      { badge: '\u2295', color: new ThemeColor('modbench.modOverwritesLooseFiles'), tooltip: 'Overwrites loose files' },
      { badge: '\u2296', color: new ThemeColor('modbench.modOverwrittenLooseFiles'), tooltip: 'Overwritten loose files' },
      undefined, undefined, undefined, undefined, undefined,
      { badge: '\u2298', color: new ThemeColor('modbench.modContainsExcludedFiles'), tooltip: 'Contains excluded files' },
      undefined,
    ]);
  });

  it('carries only the parts its settings switch on, and nothing for an indicator with both off', async () => {
    const instance = new FakeInstance(await middleOfThree());
    const decorations = decoratedOver(instance, settingsOf({
      [indicatorSetting('overwritesLooseFiles', 'badge')]: true,
      [indicatorSetting('overwrittenLooseFiles', 'colour')]: true,
    }).settings);

    expect(decorationsOn(decorations, await rowUriOf(instance, 'Middle'))).toEqual([
      { badge: '\u2295', color: undefined, tooltip: 'Overwrites loose files' },
      { badge: undefined, color: new ThemeColor('modbench.modOverwrittenLooseFiles'), tooltip: 'Overwritten loose files' },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    ]);
  });

  it('decorates no mod\'s folder where the Explorer shows it', async () => {
    const decorations = decoratedOver(new FakeInstance(await middleOfThree()), settingsOf(allOn).settings);

    expect(decorationsOn(decorations, vscode.Uri.file('/instance/Middle'))).toEqual(undecorated);
  });

  it('asks VS Code to decorate again on each new instance value, and answers from that value', async () => {
    const instance = new FakeInstance(await middleOfThree());
    const decorations = decoratedOver(instance, settingsOf(allOn).settings);
    const uri = await rowUriOf(instance, 'Low');
    const fired = decorations.providers.map((provider) => {
      const listener = vi.fn();
      provider.onDidChangeFileDecorations(listener);
      return listener;
    });
    expect(decorationsOn(decorations, uri)[6]).toEqual(REDUNDANT);

    instance.publish(await indexedValueOf([mod('Low')], { Low: { files: [file('Low', 'a.dds')] } }));

    expect(fired.map((listener) => listener.mock.calls)).toEqual(MOD_INDICATORS.map(() => [[undefined]]));
    expect(decorationsOn(decorations, uri)).toEqual(undecorated);
  });

  it('asks VS Code to decorate again only for the indicator whose setting changed', async () => {
    const { settings, changed } = settingsOf(allOn);
    const decorations = decoratedOver(new FakeInstance(await middleOfThree()), settings);
    const fired = decorations.providers.map((provider) => {
      const listener = vi.fn();
      provider.onDidChangeFileDecorations(listener);
      return listener;
    });
    const changing = (id: ModIndicator) => (key: string) => key === indicatorSetting(id, 'colour');

    changed.fire({ affectsConfiguration: (key) => key === 'modbench.something' });
    changed.fire({ affectsConfiguration: changing('redundant') });

    expect(fired.map((listener) => listener.mock.calls.length)).toEqual(MOD_INDICATORS.map(({ id }) => (id === 'redundant' ? 1 : 0)));
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
  const collapsedInstance = async () => new FakeInstance(await groupedMiddleOfThree());
  const section = separatorRowUri('Section');
  const nothing = undecorated;

  it('carries the indicators of the mods beneath it as a mod row carries its own', async () => {
    const decorations = decoratedOver(await collapsedInstance(), settingsOf(allOn).settings);

    expect(decorationsOn(decorations, section)).toEqual([
      { badge: '⊕', color: new ThemeColor('modbench.modOverwritesLooseFiles'), tooltip: 'Overwrites loose files' },
      { badge: '⊖', color: new ThemeColor('modbench.modOverwrittenLooseFiles'), tooltip: 'Overwritten loose files' },
      undefined, undefined, undefined, undefined,
      { badge: '⊗', color: new ThemeColor('modbench.modRedundant'), tooltip: 'Redundant' },
      { badge: '⊘', color: new ThemeColor('modbench.modContainsExcludedFiles'), tooltip: 'Contains excluded files' },
      undefined,
    ]);
  });

  it('carries only the parts its settings switch on', async () => {
    const decorations = decoratedOver(await collapsedInstance(), settingsOf({
      [indicatorSetting('overwritesLooseFiles', 'badge')]: true,
    }).settings);

    expect(decorationsOn(decorations, section)).toEqual([
      { badge: '⊕', color: undefined, tooltip: 'Overwrites loose files' }, ...undecorated.slice(1),
    ]);
  });

  it('carries none when no mod beneath holds one', async () => {
    const decorations = decoratedOver(await collapsedInstance(), settingsOf(allOn).settings);

    expect(decorationsOn(decorations, separatorRowUri('Quiet'))).toEqual(nothing);
  });

  it('carries none while it is expanded, and again once it collapses', async () => {
    const decorations = decoratedOver(await collapsedInstance(), settingsOf(allOn).settings);
    const fired = vi.fn();
    decorations.providers[0]?.onDidChangeFileDecorations(fired);

    decorations.open.expandedRow(section);
    const expanded = decorationsOn(decorations, section);
    decorations.open.collapsedRow(section);

    expect(expanded).toEqual(nothing);
    expect(decorationsOn(decorations, section)[0]).toEqual(OVERWRITES);
    expect(fired).toHaveBeenCalledTimes(2);
  });

  it('leaves an open mod row its own indicators', async () => {
    const instance = await collapsedInstance();
    const decorations = decoratedOver(instance, settingsOf(allOn).settings);

    decorations.open.expandedRow(modRowUri('Middle'));

    expect(decorationsOn(decorations, modRowUri('Middle'))[0]).toEqual(OVERWRITES);
  });

  it('forgets a separator that left the list, so one added later under its name starts collapsed', async () => {
    const instance = await collapsedInstance();
    const decorations = decoratedOver(instance, settingsOf(allOn).settings);
    decorations.open.expandedRow(section);

    instance.publish(await indexedValueOf([mod('Low')], { Low: { files: [file('Low', 'a.dds')] } }));
    instance.publish(await groupedMiddleOfThree());

    expect(decorationsOn(decorations, section)[0]).toEqual(OVERWRITES);
  });

  it('forgets a separator emptied while open, so one refilled starts collapsed', async () => {
    const instance = await collapsedInstance();
    const decorations = decoratedOver(instance, settingsOf(allOn).settings);
    decorations.open.expandedRow(section);

    instance.publish(await indexedValueOf([separator('Section')], {}));
    instance.publish(await groupedMiddleOfThree());

    expect(decorationsOn(decorations, section)[0]).toEqual(OVERWRITES);
  });
});

describe('a separator row (mods.md, A row, Separator)', () => {
  it('has the URI its indicators are drawn on, and no icon from the file icon theme', async () => {
    const groupedInstance = new FakeInstance(await groupedMiddleOfThree());
    const row = (await new ModListProvider({ reporter: recordingReporter(), statuses: NO_MOD_STATUSES, instance: groupedInstance, open: new OpenRows(groupedInstance) }).getChildren())
      .find((node) => node instanceof SeparatorNode && node.separator.name === 'Section');

    expect(row?.resourceUri?.toString()).toBe(separatorRowUri('Section').toString());
    expect(row?.iconPath).toEqual(new ThemeIcon('blank'));
  });
});

describe('the rows a change to some mods\' files touches (common.md, A view, story 13)', () => {
  type Change = { listings: Listings; overwrite: OriginFile[] };
  const carriedOn = (decorations: ModIndicatorDecorations, name: string): ModIndicator[] =>
    decorationsOn(decorations, modRowUri(name)).flatMap((decoration, at) => (decoration === undefined ? [] : [present(MOD_INDICATORS[at], 'an indicator').id]));

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
    const instance = new FakeInstance(before);
    const decorations = decoratedOver(instance, settingsOf(allOn).settings);
    carriedOn(decorations, name);
    const after = await indexedValueOf(mods, now.listings, { files: now.overwrite });

    instance.publish({ ...before, ...(({ files, filesByMod, foldersByMod, stackedCopies, overwriteFiles }) => ({ files, filesByMod, foldersByMod, stackedCopies, overwriteFiles }))(after) });

    expect(carriedOn(decorations, name)).toEqual(['redundant']);
  });
});
