import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, uriFile, uriFrom,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: {
    file: uriFile,
    from: (parts: { scheme: string; path: string }) => ({ ...uriFrom(parts), toString: () => `${parts.scheme}:${parts.path}` }),
  },
}));

import * as vscode from 'vscode';
import type { InstanceValue, PublisherTag } from '../../instanceLoader/instance';
import type { ModlistEntry, PublisherConfiguration } from '../../instanceAdapter/instanceAdapter';
import { modOrigin, RUNTIME_OUTPUT } from '../../instanceLoader/fileConflictIndex';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { fileRowUri } from '../modFiles';
import { indicatorSetting, modRowUri, overwriteRowUri, separatorRowUri } from '../modIndicators';
import { PublisherTagDecorations } from '../publisherTagIndicators';
import { file, folder, indexedValueOf, mod } from './indexedValue';

const tag = (badge: string, marksPaths = true): PublisherTag => ({ name: `${badge} tag`, badge, marksPaths });
const NM = tag('NM');
const IN = tag('IN');
const IG = tag('IG');
const AE = tag('AE', false);
const DECLARED = [NM, IN, IG, AE];

const COVERED_AS_THE_PUBLISHER_APPLIES_THEM_BY_MOD_AND_PATH: Record<string, readonly PublisherTag[]> = {
  'A /instance/A': [IN, AE],
  'A /instance/A/x.esp': [IN, AE],
  'A /instance/A/textures': [IN, AE],
  'A /instance/A/textures/a.dds': [IN, IG, AE],
  'B /instance/B': [IN, AE],
  'B /instance/B/y.esp': [IG, AE],
  'outside every mod /instance/overwrite/o.log': [IG],
};
const READ: PublisherConfiguration = {
  kind: 'read',
  covering: (path, mod) => COVERED_AS_THE_PUBLISHER_APPLIES_THEM_BY_MOD_AND_PATH[`${mod ?? 'outside every mod'} ${path}`] ?? [],
  listed: () => [],
  namesNoPath: [],
};

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

async function valueOf(publisherConfiguration: PublisherConfiguration = READ): Promise<InstanceValue> {
  const value = await indexedValueOf([mod('A'), separator('S'), mod('B', false), mod('C', false)], {
    A: { files: [file('A', 'x.esp'), file('A', 'textures/a.dds')], folders: [folder('A', 'textures')] },
    B: { files: [file('B', 'y.esp')] },
  }, { files: [file('overwrite', 'o.log')] });
  const modDirs = new Map(['A', 'B', 'C'].map((name) => [name, `/instance/${name}`]));
  return { ...value, paths: { ...value.paths, modDirs }, publisherTags: DECLARED, publisherConfiguration };
}

const settingsOf = (on: Partial<Record<string, boolean>>) => {
  const changed = new EventEmitter<{ affectsConfiguration: (key: string) => boolean }>();
  return { changed, settings: { getConfiguration: () => ({ get: (key: string) => on[key] }), onDidChangeConfiguration: changed.event } };
};
const BADGES_ON = { [indicatorSetting('publisherTag', 'badge')]: true };

const decorationsOver = (instance: FakeInstance, on: Partial<Record<string, boolean>> = BADGES_ON) =>
  new PublisherTagDecorations(instance, settingsOf(on).settings);

const badgesOn = (decorations: PublisherTagDecorations, uri: vscode.Uri): string[] =>
  decorations.providers.flatMap((provider) => provider.provideFileDecoration(uri)?.badge ?? []);

const expanded = (decorations: PublisherTagDecorations, ...uris: vscode.Uri[]): PublisherTagDecorations => {
  for (const uri of uris) decorations.expandedRow(uri);
  return decorations;
};

const A_TEXTURES = fileRowUri(modOrigin('A'), 'textures');

describe('the publisher tags a row carries (mods.md, Indicators; publishing.md, Publisher tags, story 1)', () => {
  it('an enabled mod carries each publisher tag that covers it, in the order its publisher declares them', async () => {
    const decorations = expanded(decorationsOver(new FakeInstance(await valueOf())), modRowUri('A'));

    expect(badgesOn(decorations, modRowUri('A'))).toEqual(['IN', 'AE']);
  });

  it('a mod carries what its publisher answers for it, whichever profile the instance has selected', async () => {
    const decorations = expanded(decorationsOver(new FakeInstance(await valueOf())), modRowUri('B'), modRowUri('C'));

    expect([badgesOn(decorations, modRowUri('B')), badgesOn(decorations, modRowUri('C'))]).toEqual([['IN', 'AE'], []]);
  });

  it('a file or folder carries each publisher tag that covers it and marks paths, in the Mods view and in the Explorer', async () => {
    const decorations = expanded(decorationsOver(new FakeInstance(await valueOf())), A_TEXTURES);

    expect({
      file: badgesOn(decorations, fileRowUri(modOrigin('A'), 'x.esp')),
      inExplorer: badgesOn(decorations, vscode.Uri.file('/instance/A/textures/a.dds')),
      folder: badgesOn(decorations, A_TEXTURES),
      inDisabledMod: badgesOn(decorations, fileRowUri(modOrigin('B'), 'y.esp')),
      inOverwrite: badgesOn(decorations, fileRowUri(RUNTIME_OUTPUT, 'o.log')),
    }).toEqual({ file: ['IN'], inExplorer: ['IN', 'IG'], folder: ['IN'], inDisabledMod: ['IG'], inOverwrite: ['IG'] });
  });

  it.each([
    ['holds no publisher\'s configuration', { kind: 'none' }],
    ['holds one Modbench cannot read', { kind: 'unreadable', reason: 'not JSON' }],
  ] as const)('no row carries one while the instance %s', async (_, configuration) => {
    const decorations = decorationsOver(new FakeInstance(await valueOf(configuration)));

    expect([modRowUri('A'), fileRowUri(modOrigin('A'), 'x.esp'), separatorRowUri('S')].map((uri) => badgesOn(decorations, uri))).toEqual([[], [], []]);
  });

  it('follows each new instance value, and asks VS Code to decorate again (ADR-0003)', async () => {
    const instance = new FakeInstance(await valueOf({ kind: 'none' }));
    const decorations = expanded(decorationsOver(instance), modRowUri('A'));
    const fired = vi.fn();
    decorations.providers[0]?.onDidChangeFileDecorations(fired);
    const before = badgesOn(decorations, modRowUri('A'));

    instance.publish(await valueOf());

    expect({ before, after: badgesOn(decorations, modRowUri('A')), fired: fired.mock.calls.length }).toEqual({ before: [], after: ['IN', 'AE'], fired: 1 });
  });
});

describe('a collapsed row\'s publisher tags (common.md, A view, story 11)', () => {
  it('a collapsed folder, mod or separator carries the publisher tags of the rows beneath it, and an expanded one only its own', async () => {
    const collapsed = decorationsOver(new FakeInstance(await valueOf()));
    const open = expanded(decorationsOver(new FakeInstance(await valueOf())), A_TEXTURES, modRowUri('A'), separatorRowUri('S'));
    const rows = [A_TEXTURES, modRowUri('A'), separatorRowUri('S')];

    expect([rows.map((uri) => badgesOn(collapsed, uri)), rows.map((uri) => badgesOn(open, uri))]).toEqual([
      [['IN', 'IG'], ['IN', 'IG', 'AE'], ['IN', 'IG', 'AE']],
      [['IN'], ['IN', 'AE'], []],
    ]);
  });

  it('a collapsed disabled mod carries its files\' publisher tags, as any collapsed row does', async () => {
    const decorations = decorationsOver(new FakeInstance(await valueOf()));

    expect(badgesOn(decorations, modRowUri('B'))).toEqual(['IN', 'IG', 'AE']);
  });

  it('a collapsed Overwrite carries the publisher tags of its files, and an expanded one none', async () => {
    const collapsed = decorationsOver(new FakeInstance(await valueOf()));
    const open = expanded(decorationsOver(new FakeInstance(await valueOf())), overwriteRowUri());

    expect([badgesOn(collapsed, overwriteRowUri()), badgesOn(open, overwriteRowUri())]).toEqual([['IG'], []]);
  });

  it('a row collapsed again carries the rows beneath it again', async () => {
    const decorations = expanded(decorationsOver(new FakeInstance(await valueOf())), modRowUri('A'));

    decorations.collapsedRow(modRowUri('A'));

    expect(badgesOn(decorations, modRowUri('A'))).toEqual(['IN', 'IG', 'AE']);
  });

  it('forgets a row that left the instance, so one back under its name starts collapsed', async () => {
    const instance = new FakeInstance(await valueOf());
    const decorations = expanded(decorationsOver(instance), modRowUri('A'), A_TEXTURES);

    instance.publish({ ...await valueOf(), mods: [] });
    instance.publish(await valueOf());

    expect([badgesOn(decorations, modRowUri('A')), badgesOn(decorations, A_TEXTURES)]).toEqual([['IN', 'IG', 'AE'], ['IN', 'IG']]);
  });
});

describe('a publisher tag\'s badge and colour, switched in settings (mods.md, Indicators)', () => {
  const colourOn = { ...BADGES_ON, [indicatorSetting('publisherTag', 'colour')]: true };

  it('a mod carries the publisher tag\'s badge and the publisher tag colour, its tooltip the publisher tag\'s name', async () => {
    const decorations = expanded(decorationsOver(new FakeInstance(await valueOf()), colourOn), modRowUri('A'));

    expect(decorations.providers[1]?.provideFileDecoration(modRowUri('A')))
      .toEqual({ badge: 'IN', color: new ThemeColor('modbench.modPublisherTag'), tooltip: 'IN tag' });
  });

  it('a file carries the badge at the right edge alone, its colour the grey\'s', async () => {
    const decorations = decorationsOver(new FakeInstance(await valueOf()), colourOn);

    expect(decorations.providers[1]?.provideFileDecoration(fileRowUri(modOrigin('A'), 'x.esp')))
      .toEqual({ badge: 'IN', color: undefined, tooltip: 'IN tag' });
  });

  it('carries nothing while both are off', async () => {
    const decorations = decorationsOver(new FakeInstance(await valueOf()), {});

    expect(decorations.providers.map((provider) => provider.provideFileDecoration(modRowUri('A')))).toEqual([undefined, undefined, undefined, undefined]);
  });
});
