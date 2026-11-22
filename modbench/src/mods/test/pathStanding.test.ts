import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri, TreeItem, TreeItemCollapsibleState, commands: { executeCommand: () => Promise.resolve() } }));

import { FileConflictLookup, modOrigin, NO_GAME_FOLDER_ARCHIVED, RUNTIME_OUTPUT, type StackedFile } from '../../instanceLoader/fileConflictIndex';
import type { FilesChanged } from '../../instanceLoader/filesChanged';
import type { InstanceValue } from '../../instanceLoader/instance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
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

describe('a .wav a plugin source names is held by the .xwm the game plays it from (source.md, Editing plugin source, story 1)', () => {
  const holds = (value: Value) => standing(value, 'sound/fx/shot.xwm').holds({ origin: 'Mod' }, 'Sound/FX/shot.wav');

  it('holds it for an .xwm the game gets', () => {
    expect(holds({ stacked: true })).toBe(true);
  });

  it('holds it for an .xwm its plugin\'s mod holds', () => {
    expect(holds({ modFiles: [file('Sound/FX/shot.xwm')] })).toBe(true);
  });

  it('holds no .wav when neither file exists', () => {
    expect(holds({})).toBe(false);
  });
});

describe('what a change tells the path problems (ADR-0029, Consequences, bullet 5)', () => {
  const told = (before: InstanceValue, after: InstanceValue): FilesChanged | undefined => {
    let hear: ((value: InstanceValue) => void) | undefined;
    const changes: FilesChanged[] = [];
    pathStandingOf({ value: before, subscribe: (listener) => { hear = listener; return { dispose: () => undefined }; } }).subscribe((changed) => changes.push(changed));
    hear?.(before);
    hear?.(after);
    return changes[1];
  };
  const before = instanceValueFixture({ filesByMod: new Map([['Mod', [file('a.dds')]]]) });
  const gained = { ...before, filesByMod: new Map([['Mod', [file('a.dds'), file('B.dds')]]]) };
  const overwritten = { ...before, overwriteFiles: [file('o.dds', '/overwrite/o.dds')] };

  it.each<[string, InstanceValue, FilesChanged]>([
    ['a mod gains a file: that mod, with the files it holds and held', gained, [{ origin: modOrigin('Mod'), files: [file('a.dds'), file('a.dds'), file('B.dds')] }]],
    ['Overwrite gains a file: Overwrite', overwritten, [{ origin: RUNTIME_OUTPUT, files: [file('o.dds', '/overwrite/o.dds')] }]],
    ['a mod gains a file while an archive starts to load: anything', { ...gained, loadsArchive: () => true }, 'every'],
  ])('tells, when %s', (_case, after, changed) => {
    expect(told(before, after)).toEqual(changed);
  });
});
