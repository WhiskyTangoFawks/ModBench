import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type * as vscode from 'vscode';
import { modsViewOn } from './modsViewOn';
import { answers, seen } from './modsVscode';
import type { InstanceValue, PublisherTag } from '../../instanceLoader/instance';
import type { ModlistEntry, PublisherConfiguration } from '../../instanceAdapter/instanceAdapter';
import { present } from '../../ports/present';
import { FakeCancellationToken, ThemeColor, Uri } from '../../test/vscodeMock';
import { file, folder, indexedValueOf, indexedValues, mod } from './indexedValue';

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
  pathProblems: [],
  unshippable: { file: '', reason: () => undefined },
};

const BADGE_SETTING = 'modbench.mods.indicators.publisherTag.badge';
const COLOUR_SETTING = 'modbench.mods.indicators.publisherTag.colour';

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

async function valueOf(publisherConfiguration: PublisherConfiguration = READ): Promise<InstanceValue> {
  const value = await indexedValueOf([mod('A'), separator('S'), mod('B', false), mod('C', false)], {
    A: { files: [file('A', 'x.esp'), file('A', 'textures/a.dds')], folders: [folder('A', 'textures')] },
    B: { files: [file('B', 'y.esp')] },
  }, { files: [file('overwrite', 'o.log')] });
  const modDirs = new Map(['A', 'B', 'C'].map((name) => [name, `/instance/${name}`]));
  return { ...value, paths: { ...value.paths, modDirs }, publisherTags: DECLARED, publisherConfiguration };
}

async function shownOver(value: InstanceValue, badges = true) {
  const shown = modsViewOn({ value });
  answers.settings.set(BADGE_SETTING, badges);
  const { row } = shown;
  const s = await row('S');
  const a = await row('A', s);
  const b = await row('B');
  const overwrite = await row('Overwrite');
  const rows = {
    s, a, b, c: await row('C'), overwrite, textures: await row('textures', a), xEsp: await row('x.esp', a), yEsp: await row('y.esp', b), oLog: await row('o.log', overwrite),
  };
  const uriOf = (name: keyof typeof rows) => present(rows[name].resourceUri, `the URI of ${name}`);
  const badgesOn = async (uri: vscode.Uri): Promise<string[]> => (await shown.decorationsOf(uri)).flatMap(({ badge }) => badge ?? []);
  return { ...shown, rows, uriOf, badgesOn, carried: async (name: keyof typeof rows) => badgesOn(uriOf(name)) };
}

describe('the publisher tags a row carries as a change reaches it, counted file by file (ADR-0029, Consequences, bullet 5)', () => {
  it('carries a tag beneath a mod and its folder once the mod gains a file it covers, and drops it once the mod loses that file', async () => {
    const next = indexedValues([mod('A')]);
    const kept = [file('A', 'x.esp')];
    const folders = [folder('A', 'textures')];
    const first = next({ A: { files: kept, folders } });
    const paths = { ...first.paths, modDirs: new Map([['A', '/instance/A']]) };
    const valued = (value: InstanceValue): InstanceValue => ({ ...value, paths, publisherTags: DECLARED, publisherConfiguration: READ });
    const shown = modsViewOn({ value: valued(first) });
    answers.settings.set(BADGE_SETTING, true);
    const a = await shown.row('A');
    const [modA, textures] = [present(a.resourceUri, 'A\'s URI'), present((await shown.row('textures', a)).resourceUri, 'its folder\'s URI')];
    const badges = async (uri: vscode.Uri) => (await shown.decorationsOf(uri)).flatMap(({ badge }) => badge ?? []);
    const carried = async () => [await badges(modA), await badges(textures)];
    const before = await carried();

    shown.instance.publish(valued(next({ A: { files: [...kept, file('A', 'textures/a.dds')], folders } })));
    const gained = await carried();
    shown.instance.publish(valued(next({ A: { files: kept, folders } })));

    expect([before, gained, await carried()]).toEqual([[['IN', 'AE'], ['IN']], [['IN', 'IG', 'AE'], ['IN', 'IG']], [['IN', 'AE'], ['IN']]]);
  });
});

describe('the publisher tags a row carries (mods.md, Indicators; publishing.md, Publisher tags, story 1)', () => {
  it('an enabled mod carries each publisher tag that covers it, in the order its publisher declares them', async () => {
    const { view, rows, carried } = await shownOver(await valueOf());

    view.expand(rows.a);

    expect(await carried('a')).toEqual(['IN', 'AE']);
  });

  it('a mod carries what its publisher answers for it, whichever profile the instance has selected', async () => {
    const { view, rows, carried } = await shownOver(await valueOf());

    view.expand(rows.b);
    view.expand(rows.c);

    expect([await carried('b'), await carried('c')]).toEqual([['IN', 'AE'], []]);
  });

  it('a file or folder carries each publisher tag that covers it and marks paths, in the Mods view and in the Explorer', async () => {
    const { view, rows, carried, badgesOn } = await shownOver(await valueOf());

    view.expand(rows.textures);

    expect({
      file: await carried('xEsp'),
      inExplorer: await badgesOn(Uri.file('/instance/A/textures/a.dds')),
      folder: await carried('textures'),
      inDisabledMod: await carried('yEsp'),
      inOverwrite: await carried('oLog'),
    }).toEqual({ file: ['IN'], inExplorer: ['IN', 'IG'], folder: ['IN'], inDisabledMod: ['IG'], inOverwrite: ['IG'] });
  });

  it.each([
    ['holds no publisher\'s configuration', { kind: 'none' }],
    ['holds one Modbench cannot read', { kind: 'unreadable', reason: 'not JSON' }],
  ] as const)('no row carries one while the instance %s', async (_, configuration) => {
    const { carried } = await shownOver(await valueOf(configuration));

    expect([await carried('a'), await carried('xEsp'), await carried('s')]).toEqual([[], [], []]);
  });

  it('follows each new instance value, and asks VS Code to decorate again (ADR-0003)', async () => {
    const { view, rows, carried, instance, uriOf } = await shownOver(await valueOf({ kind: 'none' }));
    view.expand(rows.a);
    const heard = seen.decorationProviders.map((provider) => {
      const told: unknown[] = [];
      provider.onDidChangeFileDecorations?.((uris) => { told.push(uris); });
      return { provider, told };
    });
    const before = await carried('a');

    instance.publish(await valueOf());

    const answered = await Promise.all(heard.map(async ({ provider, told }) => ({ badge: (await provider.provideFileDecoration(uriOf('a'), new FakeCancellationToken()))?.badge, told })));
    expect({ before, after: await carried('a'), fired: present(answered.find(({ badge }) => badge === 'IN'), 'IN\'s provider').told.length })
      .toEqual({ before: [], after: ['IN', 'AE'], fired: 1 });
  });
});

describe('a collapsed row\'s publisher tags (common.md, A view, story 11)', () => {
  it('a collapsed folder, mod or separator carries the publisher tags of the rows beneath it, and an expanded one only its own', async () => {
    const { view, rows, carried } = await shownOver(await valueOf());
    const collapsed = [await carried('textures'), await carried('a'), await carried('s')];

    view.expand(rows.textures);
    view.expand(rows.a);
    view.expand(rows.s);

    expect([collapsed, [await carried('textures'), await carried('a'), await carried('s')]]).toEqual([
      [['IN', 'IG'], ['IN', 'IG', 'AE'], ['IN', 'IG', 'AE']],
      [['IN'], ['IN', 'AE'], []],
    ]);
  });

  it('a collapsed disabled mod carries its files\' publisher tags, as any collapsed row does', async () => {
    const { carried } = await shownOver(await valueOf());

    expect(await carried('b')).toEqual(['IN', 'IG', 'AE']);
  });

  it('a collapsed Overwrite carries the publisher tags of its files, and an expanded one none', async () => {
    const { view, rows, carried } = await shownOver(await valueOf());
    const collapsed = await carried('overwrite');

    view.expand(rows.overwrite);

    expect([collapsed, await carried('overwrite')]).toEqual([['IG'], []]);
  });

  it('a row collapsed again carries the rows beneath it again', async () => {
    const { view, rows, carried } = await shownOver(await valueOf());
    view.expand(rows.a);

    view.collapse(rows.a);

    expect(await carried('a')).toEqual(['IN', 'IG', 'AE']);
  });

  it('forgets a row that left the instance, so one back under its name starts collapsed', async () => {
    const { view, rows, carried, instance } = await shownOver(await valueOf());
    view.expand(rows.a);
    view.expand(rows.textures);

    instance.publish({ ...await valueOf(), mods: [] });
    instance.publish(await valueOf());

    expect([await carried('a'), await carried('textures')]).toEqual([['IN', 'IG', 'AE'], ['IN', 'IG']]);
  });
});

describe('a publisher tag\'s badge and colour, switched in settings (mods.md, Indicators)', () => {
  const colourOn = async () => {
    const shown = await shownOver(await valueOf());
    answers.settings.set(COLOUR_SETTING, true);
    return shown;
  };

  it('a mod carries the publisher tag\'s badge and the publisher tag colour, its tooltip the publisher tag\'s name', async () => {
    const { view, rows, decorationsOf, uriOf } = await colourOn();

    view.expand(rows.a);

    expect(await decorationsOf(uriOf('a'))).toEqual([
      { badge: 'IN', color: new ThemeColor('modbench.modPublisherTag'), tooltip: 'IN tag' },
      { badge: 'AE', color: new ThemeColor('modbench.modPublisherTag'), tooltip: 'AE tag' },
    ]);
  });

  it('a file carries the badge at the right edge alone, its colour the grey\'s', async () => {
    const { decorationsOf, uriOf } = await colourOn();

    expect(await decorationsOf(uriOf('xEsp'))).toEqual([{ badge: 'IN', color: undefined, tooltip: 'IN tag' }]);
  });

  it('carries nothing while both are off', async () => {
    const { decorationsOf, uriOf } = await shownOver(await valueOf(), false);

    expect(await decorationsOf(uriOf('a'))).toEqual([]);
  });
});
