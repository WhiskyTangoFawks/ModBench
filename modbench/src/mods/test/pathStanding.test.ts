import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri, TreeItem, TreeItemCollapsibleState, commands: { executeCommand: () => Promise.resolve() } }));

import { FileConflictLookup, modOrigin, NO_GAME_FOLDER_ARCHIVED, type StackedFile } from '../../instanceLoader/fileConflictIndex';
import { pathStandingOf } from '../pathStanding';
import type { GameFolder, OriginFile } from '../../instanceAdapter/instanceAdapter';

const PATH = 'textures/decals/stain_d.dds';
const FOUND: GameFolder = { kind: 'found', root: '/game', dataFolder: '/game/Data' };
const NOT_FOUND: GameFolder = { kind: 'notFound', looked: [], setting: 'gameFolder' };
const file = (relativePath: string, sourcePath = `/mods/Mod/${relativePath}`): OriginFile => ({ relativePath, sourcePath, path: sourcePath, includedPath: relativePath, excluded: false, markedExcluded: false });

interface Value {
  gameFolder?: GameFolder;
  inWorkspace?: boolean;
  gameLoose?: true;
  stacked?: true;
  modFiles?: OriginFile[];
  archive?: readonly string[];
  gameName?: string;
}

function standing({ gameFolder = FOUND, inWorkspace = true, gameLoose, stacked, modFiles = [], archive, gameName = 'Fallout 4' }: Value, path = PATH) {
  const stackedCopies = new FileConflictLookup<StackedFile>();
  if (stacked) stackedCopies.set({ relativePath: path, copies: [{ origin: modOrigin('Other'), at: { kind: 'loose', path: '/mods/Other/x' } }] });
  const value = {
    gameName, stackedCopies, gameFolderArchived: NO_GAME_FOLDER_ARCHIVED, gameFolderInWorkspace: inWorkspace, gameFolder,
    dataFolderFiles: { kind: 'listed' as const, files: new Map(gameLoose ? [[path, { relativePath: path, path: `/game/Data/${path}` }]] : []) },
    filesByMod: new Map([['Mod', modFiles]]), overwriteFiles: [],
    archiveContents: new Map(archive ? [['/mods/Mod/Mod.ba2', { kind: 'read' as const, answer: archive }]] : []),
  };
  return pathStandingOf({ value, subscribe: () => ({ dispose: () => undefined }) });
}

describe('what holds a path a plugin source names (source.md, Editing plugin source, story 1)', () => {
  it.each<[string, Value, boolean]>([
    ['a copy the game gets', { stacked: true }, true],
    ['a loose file in a game folder the workspace holds', { gameLoose: true }, true],
    ['a loose file in a game folder outside the workspace', { gameLoose: true, inWorkspace: false }, false],
    ['a file its plugin\'s mod holds that the game does not get', { modFiles: [file('Textures/Decals/Stain_d.dds')] }, true],
    ['a file in an archive its plugin\'s mod holds', { modFiles: [file('Mod.ba2')], archive: ['Textures/Decals/Stain_d.dds'] }, true],
    ['no file at all', {}, false],
  ])('holds %s: %s', (_what, value, held) => {
    expect(standing(value).holds({ origin: 'Mod' }, 'Textures/Decals/Stain_d.dds')).toBe(held);
  });

  it('holds a path spelled with backslashes', () => {
    expect(standing({ stacked: true }).holds({ origin: 'Mod' }, 'Textures\\Decals\\Stain_d.dds')).toBe(true);
  });

  it.each<[string, Value, boolean]>([
    ['judged while the game folder is in the workspace', {}, true],
    ['not judged while the game folder is outside it', { inWorkspace: false }, false],
    ['not judged while no game folder is found, as before the first read', { gameFolder: NOT_FOUND, inWorkspace: false }, false],
  ])('is %s', (_what, value, judged) => {
    expect(standing(value).judged()).toBe(judged);
  });
});

describe('a sound descriptor names a .wav the game plays from its .xwm (source.md, Editing plugin source, story 1)', () => {
  const WAV = 'Sound/FX/shot.wav';
  const XWM = 'sound/fx/shot.xwm';
  const holds = (value: Value, named = WAV, at = XWM) => standing(value, at).holds({ origin: 'Mod' }, named);

  it.each<[string, Value]>([
    ['a copy of the .xwm the game gets', { stacked: true }],
    ['a loose .xwm in the game folder', { gameLoose: true }],
    ['an .xwm its plugin\'s mod holds', { modFiles: [file('Sound/FX/shot.xwm')] }],
    ['an .xwm in an archive its plugin\'s mod holds', { modFiles: [file('Mod.ba2')], archive: ['Sound/FX/shot.xwm'] }],
  ])('holds the .wav path for %s', (_what, value) => {
    expect(holds(value)).toBe(true);
  });

  it('holds no .wav path when neither file exists', () => {
    expect(holds({})).toBe(false);
  });

  it('holds an .xwm path only at its exact path', () => {
    expect(holds({ stacked: true }, 'Sound/FX/shot.xwm', 'sound/fx/shot.wav')).toBe(false);
  });

  it('holds a .wav path of a game before Skyrim at its exact path', () => {
    expect(holds({ stacked: true, gameName: 'Oblivion' })).toBe(false);
  });
});
