import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type * as vscode from 'vscode';
import { modsViewOn } from './modsViewOn';
import { changeSetting, seen } from './modsVscode';
import type { InstanceValue } from '../../instanceLoader/instance';
import { modOrigin } from '../../instanceLoader/fileConflictIndex';
import { present } from '../../ports/present';
import { FakeCancellationToken, ThemeColor, Uri } from '../../test/vscodeMock';
import { file, folder, indexedValueOf, indexedValues, mod } from './indexedValue';

const GREY_INACTIVE_FILES_SETTING = 'modbench.mods.greyInactiveFiles';

const isGrey = (decoration: vscode.FileDecoration | null | undefined): boolean =>
  decoration?.badge === undefined && decoration?.color instanceof ThemeColor && decoration.color.id === 'disabledForeground';

type Shown = ReturnType<typeof modsViewOn>;

const greyed = async ({ decorationsOf }: Shown, uri: vscode.Uri): Promise<boolean> => (await decorationsOf(uri)).some(isGrey);

const rowUri = async ({ row }: Shown, ...path: string[]): Promise<vscode.Uri> => {
  const shown = await path.reduce<Promise<vscode.TreeItem | undefined>>(async (parent, name) => row(name, await parent), Promise.resolve(undefined));
  return present(shown?.resourceUri, `the URI of ${path.join('/')}`);
};

const redrawsOfTheGrey = (uri: vscode.Uri): (() => Promise<unknown[]>) => {
  const heard = seen.decorationProviders.map((provider) => {
    const told: unknown[] = [];
    provider.onDidChangeFileDecorations?.((uris) => { told.push(uris); });
    return { provider, told };
  });
  return async () => {
    const answered = await Promise.all(heard.map(async ({ provider, told }) => ({ grey: isGrey(await provider.provideFileDecoration(uri, new FakeCancellationToken())), told })));
    return present(answered.find(({ grey }) => grey), 'the provider of the grey').told;
  };
};

const winnerAndLoser = () => indexedValueOf([mod('Winner'), mod('Loser')], {
  Winner: { files: [file('Winner', 'x/a.dds')], folders: [folder('Winner', 'x')] },
  Loser: { files: [file('Loser', 'x/a.dds')], folders: [folder('Loser', 'x')] },
});

const archiveInEachMod = async (loads: boolean, mods = [mod('A')]): Promise<InstanceValue> => {
  const archive = (name: string) => file(name, 'A - Main.ba2');
  const winner = mods.find(({ enabled }) => enabled);
  const loaded = loads && winner !== undefined ? [{ origin: modOrigin(winner.name), archive: archive(winner.name).sourcePath, files: ['meshes/a.nif'] }] : [];
  return {
    ...await indexedValueOf(mods, Object.fromEntries(mods.map(({ name }) => [name, { files: [archive(name)] }])), { files: [] }, loaded),
    archiveContents: new Map(mods.map(({ name }) => [archive(name).sourcePath, { kind: 'read', answer: ['meshes/a.nif'] }])),
    loadsArchive: (name) => loads && name === 'A - Main.ba2',
  };
};

const archivedCopies = async (loose: string[], archives: string[], loadedArchives: string[]): Promise<InstanceValue> => {
  const names = [...new Set([...loose, ...archives])];
  const archiveOf = (name: string) => file(name, `${name}.ba2`);
  const value = await indexedValueOf(names.map((name) => mod(name)), Object.fromEntries(names.map((name) => [name, {
    files: [...(loose.includes(name) ? [file(name, 'meshes/a.nif')] : []), ...(archives.includes(name) ? [archiveOf(name)] : [])],
  }])), { files: [] }, loadedArchives.map((name) => ({ origin: modOrigin(name), archive: archiveOf(name).sourcePath, files: ['meshes/a.nif'] })));
  return {
    ...value, loadsArchive: (archive) => loadedArchives.some((name) => archiveOf(name).relativePath === archive),
    archiveContents: new Map(archives.map((name) => [archiveOf(name).sourcePath, { kind: 'read', answer: ['meshes/a.nif'] }])),
  };
};

const inGameFolder = async (value: Promise<InstanceValue>, ...relativePaths: string[]): Promise<InstanceValue> => ({
  ...await value,
  dataFolderFiles: { kind: 'listed', files: new Map(relativePaths.map((relativePath) => [relativePath, { relativePath, path: `/game/Data/${relativePath}` }])) },
});

describe('an archived file the game does not get (mods.md, The tree, story 8)', () => {
  it.each<[string, () => Promise<InstanceValue>, string, boolean]>([
    ['a loose copy beats it', () => archivedCopies(['L'], ['A'], ['A']), 'A', true],
    ['a later-loaded archive beats it', () => archivedCopies([], ['A', 'B'], ['A', 'B']), 'A', true],
    ['it beats an earlier-loaded archive: it is the copy the game gets', () => archivedCopies([], ['A', 'B'], ['A', 'B']), 'B', false],
    ['it alone is the copy the game gets', () => archivedCopies([], ['A'], ['A']), 'A', false],
    ['a loose copy in the game folder beats it', () => inGameFolder(archivedCopies([], ['A'], ['A']), 'meshes/a.nif'), 'A', true],
    ['a loose copy in the game folder at another path leaves it', () => inGameFolder(archivedCopies([], ['A'], ['A']), 'meshes/b.nif'), 'A', false],
  ])('%s', async (_case, value, owner, grey) => {
    const shown = modsViewOn({ value: await value() });

    expect(await greyed(shown, await rowUri(shown, owner, `${owner}.ba2`, 'meshes', 'a.nif'))).toBe(grey);
  });
});

describe('each file of a mod or Overwrite, active or inactive (mods.md, The tree, story 8)', () => {
  const offWithAFolder = () => indexedValueOf([mod('Off', false)], { Off: { files: [file('Off', 'x/a.dds')], folders: [folder('Off', 'x')] } });

  it.each<[string, () => Promise<InstanceValue>, string[], boolean]>([
    ['a file another copy wins is inactive', winnerAndLoser, ['Loser', 'x', 'a.dds'], true],
    ['the copy that wins is active', winnerAndLoser, ['Winner', 'x', 'a.dds'], false],
    ['a folder whose every file loses is still active: the game merges folders', winnerAndLoser, ['Loser', 'x'], false],
    ['an excluded file is inactive', () => indexedValueOf([mod('A')], { A: { files: [file('A', 'a.dds', true)] } }), ['A', 'a.dds'], true],
    ['a disabled mod\'s file is inactive', offWithAFolder, ['Off', 'x', 'a.dds'], true],
    ['a disabled mod\'s folder is inactive', offWithAFolder, ['Off', 'x'], true],
    ['an excluded folder is inactive', () => indexedValueOf([mod('A')], { A: { files: [], folders: [folder('A', 'x', true)] } }), ['A', 'x'], true],
    ['an excluded file in Overwrite is inactive', () => indexedValueOf([], {}, { files: [file('overwrite', 'b.log', true)] }), ['Overwrite', 'b.log'], true],
    ['a file in an archive the game loads is active', () => archiveInEachMod(true), ['A', 'A - Main.ba2', 'meshes', 'a.nif'], false],
    ['a file in an archive the game does not load is inactive', () => archiveInEachMod(false), ['A', 'A - Main.ba2', 'meshes', 'a.nif'], true],
    ['a folder in an archive the game does not load is inactive', () => archiveInEachMod(false), ['A', 'A - Main.ba2', 'meshes'], true],
    ['a file in an archive the game loads from another mod is inactive', () => archiveInEachMod(true, [mod('B'), mod('A')]), ['A', 'A - Main.ba2', 'meshes', 'a.nif'], true],
    ['a file in an archive of a disabled mod is inactive', () => archiveInEachMod(true, [mod('A', false)]), ['A', 'A - Main.ba2', 'meshes', 'a.nif'], true],
  ])('%s', async (_case, value, path, grey) => {
    const shown = modsViewOn({ value: await value() });

    expect(await greyed(shown, await rowUri(shown, ...path))).toBe(grey);
  });
});

describe('the grey on a file the game does not get, in the Mods tree and the Explorer (mods.md, The tree, stories 8 and 10)', () => {
  it('greys the row of a file the game does not get, and the file itself where the Explorer shows it', async () => {
    const shown = modsViewOn({ value: await indexedValueOf([mod('Winner'), mod('Loser')], {
      Winner: { files: [file('Winner', 'a.dds')] }, Loser: { files: [file('Loser', 'a.dds')] },
    }) });

    expect([
      await greyed(shown, await rowUri(shown, 'Loser', 'a.dds')), await greyed(shown, Uri.file('/instance/Loser/a.dds')), await greyed(shown, Uri.file('/instance/Winner/a.dds')),
    ]).toEqual([true, true, false]);
  });

  it('greys an excluded folder where the Explorer shows it', async () => {
    const shown = modsViewOn({ value: await indexedValueOf([mod('A')], { A: { files: [], folders: [folder('A', 'x', true)] } }) });

    expect(await greyed(shown, Uri.file('/instance/A/x'))).toBe(true);
  });

  it('greys nothing while the setting is off, and greys on by default', async () => {
    const shown = modsViewOn({ value: await indexedValueOf([mod('Off', false)], { Off: { files: [file('Off', 'a.dds')] } }) });
    const uri = Uri.file('/instance/Off/a.dds');
    const byDefault = await greyed(shown, uri);

    changeSetting(GREY_INACTIVE_FILES_SETTING, false);
    const off = await greyed(shown, uri);
    changeSetting(GREY_INACTIVE_FILES_SETTING, true);

    expect([byDefault, off, await greyed(shown, uri)]).toEqual([true, false, true]);
  });

  it('asks VS Code to decorate again on each new instance value, and answers from that value', async () => {
    const shown = modsViewOn({ value: await indexedValueOf([mod('A')], { A: { files: [file('A', 'a.dds')] } }) });
    const uri = Uri.file('/instance/A/a.dds');
    const redraws = redrawsOfTheGrey(uri);
    const before = await greyed(shown, uri);

    shown.instance.publish(await indexedValueOf([mod('A', false)], { A: { files: [file('A', 'a.dds')] } }));

    expect([before, await greyed(shown, uri), await redraws()]).toEqual([false, true, [undefined]]);
  });

  it('greys the file in a mod\'s archive once another mod gains a loose copy that wins over it, and not once that copy is lost', async () => {
    const archive = file('A', 'A - Main.ba2');
    const next = indexedValues([mod('A'), mod('B')], [{ origin: modOrigin('A'), archive: archive.sourcePath, files: ['textures/x.dds'] }]);
    const archiveFiles = { A: { files: [archive] } };
    const shown = modsViewOn({ value: next({ ...archiveFiles, B: { files: [] } }) });
    const uri = await rowUri(shown, 'A', 'A - Main.ba2', 'textures', 'x.dds');
    const greyedBefore = await greyed(shown, uri);

    shown.instance.publish(next({ ...archiveFiles, B: { files: [file('B', 'textures/x.dds')] } }));
    const greyedWon = await greyed(shown, uri);
    shown.instance.publish(next({ ...archiveFiles, B: { files: [] } }));

    expect([greyedBefore, greyedWon, await greyed(shown, uri)]).toEqual([false, true, false]);
  });

  it('greys, of two case variants of a path in another mod, the one the file conflict index takes, the first', async () => {
    const next = indexedValues([mod('Winner'), mod('Loser')]);
    const losing = [file('Loser', 'a.dds'), file('Loser', 'A.dds')];
    const shown = modsViewOn({ value: next({ Winner: { files: [] }, Loser: { files: losing } }) });
    const uri = Uri.file('/instance/Loser/a.dds');
    const before = await greyed(shown, uri);

    shown.instance.publish(next({ Winner: { files: [file('Winner', 'a.dds')] }, Loser: { files: losing } }));

    expect([before, await greyed(shown, uri)]).toEqual([false, true]);
  });

  it('greys another mod\'s copy once a mod gains the file that wins over it, and an excluded folder a mod gains', async () => {
    const next = indexedValues([mod('Winner'), mod('Loser')]);
    const losing = [file('Loser', 'a.dds')];
    const shown = modsViewOn({ value: next({ Winner: { files: [] }, Loser: { files: losing } }) });
    const [loser, folderGained] = [Uri.file('/instance/Loser/a.dds'), Uri.file('/instance/Winner/x')];
    const before = [await greyed(shown, loser), await greyed(shown, folderGained)];

    shown.instance.publish(next({ Winner: { files: [file('Winner', 'a.dds')], folders: [folder('Winner', 'x', true)] }, Loser: { files: losing } }));

    expect([...before, await greyed(shown, loser), await greyed(shown, folderGained)]).toEqual([false, false, true, true]);
  });

  it('asks VS Code to decorate again when its setting changes, and only then', async () => {
    modsViewOn({ value: await indexedValueOf([mod('Off', false)], { Off: { files: [file('Off', 'a.dds')] } }) });
    const redraws = redrawsOfTheGrey(Uri.file('/instance/Off/a.dds'));

    changeSetting('modbench.something', true);
    const unrelated = [...await redraws()];
    changeSetting(GREY_INACTIVE_FILES_SETTING, true);

    expect([unrelated, await redraws()]).toEqual([[], [undefined]]);
  });
});
