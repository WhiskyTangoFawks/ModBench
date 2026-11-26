import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { adapterForInstance } from '../openInstance';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { fixedGameFolderSetting } from '../../test/gameFolderSetting';
import { watcherExcluding } from '../../test/watcherExclusion';
import { hostWithoutGit } from '../../test/hostGitDouble';
import { fakeInstallationFileReader } from '../../test/fakeInstallationFileReader';
import { fileProblemsFake } from '../../test/fileProblemsFake';
import { FOMOD_ENGINE } from '../../test/fomodEngine';
import { DEPLOYED_PATH } from '../../test/deployedPath';

const EXCLUDED = 'excluded in files.watcherExclude';
const FILES = ['mods/Harder VATS/textures/actors/a.dds', 'mods/Harder VATS/Harder VATS.esp', 'mods/Patch Mod/textures/b.dds'];

describe('what the user excluded from VS Code\'s watch (files.watcherExclude) names the folders the watch misses', () => {
  let root: string;
  let game: string;
  const gamePattern = (): string => `${game.split(sep).join('/')}/Data/**`;

  beforeAll(async () => {
    root = cloneCorpusFixture();
    game = await mkdtemp(join(tmpdir(), 'medit-excluded-game-'));
    await mkdir(join(game, 'Data'));
    for (const file of FILES) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), '');
    }
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(game, { recursive: true, force: true });
  });

  const unwatched = async (patterns: Record<string, boolean>): Promise<{ folder: string; reason: string }[]> => {
    const adapter = adapterForInstance({
      instanceRoot: root, gameFolderSetting: fixedGameFolderSetting(game), watcherExclude: watcherExcluding(patterns), hostGit: hostWithoutGit,
      installationFileReader: fakeInstallationFileReader([]), fileProblems: fileProblemsFake(), fomodEngine: FOMOD_ENGINE, deployedPath: DEPLOYED_PATH,
      scriptEnvironmentFileSetting: () => undefined,
    });
    const subscription = adapter.subscribe(() => undefined);
    try {
      const { unwatchedFolders } = await adapter.reading();
      return unwatchedFolders.map(({ folder, reason }) => ({ folder: relative(root, folder).split(sep).join('/'), reason }))
        .sort((a, b) => a.folder.localeCompare(b.folder) || a.reason.localeCompare(b.reason));
    } finally {
      subscription.dispose();
    }
  };
  const excluded = (...folders: string[]) => folders.map((folder) => ({ folder, reason: EXCLUDED }));
  const filesMatching = (pattern: string) => [{ folder: 'mods', reason: `files matching ${pattern} are ${EXCLUDED}` }];

  it.each([
    ['a folder-and-below pattern, the folder itself and so every folder below it', { '**/mods/**': true }, excluded('mods')],
    ['a pattern relative to the instance root', { 'mods/**': true }, excluded('mods')],
    ['a folder pattern', { '**/mods': true }, excluded('mods')],
    ['a pattern for one mod, that mod alone', { '**/mods/Harder VATS/**': true }, excluded('mods/Harder VATS')],
    ['a pattern for a folder name at any depth, each topmost folder of that name', { '**/textures/**': true }, excluded('mods/Harder VATS/textures', 'mods/Patch Mod/textures')],
    ['a pattern for a folder below one mod, that folder alone', { '**/mods/Harder VATS/textures/**': true }, excluded('mods/Harder VATS/textures')],
    ['an alternation of folder names', { '**/{actors,textures}': true }, excluded('mods/Harder VATS/textures', 'mods/Patch Mod/textures')],
    ['a pattern for a folder name nothing listed has', { '**/a/**': true }, []],
    ['a pattern set false', { '**/mods/**': false }, []],
    ['a default pattern', { '**/.git/objects/**': true }, []],
  ])('names, for %s, the topmost excluded folders', async (_what, patterns, named) => {
    expect(await unwatched(patterns)).toEqual(named);
  });

  it.each([
    ['a pattern for files', { '**/*.dds': true }, filesMatching('**/*.dds')],
    ['a pattern for files under one extension in a folder', { '**/textures/*.dds': true }, filesMatching('**/textures/*.dds')],
    ['an alternation of extensions', { '**/*.{dds,png}': true }, filesMatching('**/*.{dds,png}')],
    ['a pattern for an extension nothing listed has', { '**/*.png': true }, []],
    ['a pattern set false', { '**/*.dds': false }, []],
    ['each of two patterns', { '**/*.dds': true, '**/*.esp': true }, [...filesMatching('**/*.dds'), ...filesMatching('**/*.esp')]],
  ])('names, for %s, each pattern that excludes a listed file', async (_what, patterns, named) => {
    expect(await unwatched(patterns)).toEqual(named);
  });

  it('tells an absolute pattern for a folder outside the instance', async () => {
    expect(await unwatched({ [gamePattern()]: true })).toEqual([{ folder: relative(root, join(game, 'Data')).split(sep).join('/'), reason: EXCLUDED }]);
  });
});
