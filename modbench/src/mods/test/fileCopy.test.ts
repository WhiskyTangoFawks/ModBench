import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri, TreeItem, TreeItemCollapsibleState, commands: { executeCommand: () => Promise.resolve() } }));

import { FileConflictLookup, modOrigin, NO_GAME_FOLDER_ARCHIVED, type CopyAt, type GameFolderArchived, type StackedFile } from '../../instanceLoader/fileConflictIndex';
import { copyTheGameGets } from '../fileCopy';

const PATH = 'textures/decals/stain_d.dds';
const LOOSE: CopyAt = { kind: 'loose', path: '/instance/mods/Mod/Textures/Decals/Stain_d.dds' };
const ARCHIVED: CopyAt = { kind: 'archived', gameRelease: 'Fallout4', archive: '/instance/mods/Mod/Mod - Textures.ba2', file: PATH };

function held(winner: CopyAt | undefined, inGameFolder = false, listed = true, gameFolderArchived: GameFolderArchived = NO_GAME_FOLDER_ARCHIVED) {
  const stackedCopies = new FileConflictLookup<StackedFile>();
  if (winner) stackedCopies.set({ relativePath: PATH, copies: [{ origin: modOrigin('Mod'), at: winner }] });
  const files = new Map(inGameFolder ? [[PATH, { relativePath: PATH, path: '/game/Data/Textures/Decals/Stain_d.dds' }]] : []);
  return { stackedCopies, gameFolderArchived, dataFolderFiles: listed ? { kind: 'listed' as const, files } : { kind: 'unresolved' as const } };
}

const INSIDE = () => true;

describe('the copy of a file the game gets (symbols.md, The symbols, File)', () => {
  it.each([
    ['a loose copy in a mod', held(LOOSE), LOOSE],
    ['an archived copy in a mod', held(ARCHIVED), ARCHIVED],
    ['a loose copy in a mod, over the game folder\'s', held(LOOSE, true), LOOSE],
    ['the game folder\'s loose copy, over an archived copy in a mod', held(ARCHIVED, true), { kind: 'loose', path: '/game/Data/Textures/Decals/Stain_d.dds' }],
    ['the game folder\'s own copy, when no mod has one', held(undefined, true), { kind: 'loose', path: '/game/Data/Textures/Decals/Stain_d.dds' }],
    ['what was searched, when no mod or Data folder file holds it', held(undefined), { none: `No enabled mod, Overwrite or loose file in the Data folder holds ${PATH}.` }],
    ['what was searched, when the Data folder cannot be listed', held(undefined, false, false), { none: `No enabled mod or Overwrite holds ${PATH}, and the Data folder's files could not be listed.` }],
  ])('is %s', (_case, value, copy) => {
    expect(copyTheGameGets(value, PATH, INSIDE)).toEqual(copy);
  });

  it('is found by a path in any case', () => {
    expect(copyTheGameGets(held(LOOSE), 'Textures/Decals/Stain_D.dds', INSIDE)).toEqual(LOOSE);
  });
});

describe('a game folder outside the workspace (ADR-0001)', () => {
  const outside = () => false;

  it('is no definition for its loose file, and the answer says why', () => {
    expect(copyTheGameGets(held(undefined, true), PATH, outside)).toEqual({
      none: `${PATH} is in the game folder, which is outside the workspace.`,
    });
  });

  it('is no definition over an archived copy in a mod, which stays the copy shown', () => {
    expect(copyTheGameGets(held(ARCHIVED, true), PATH, outside)).toEqual(ARCHIVED);
  });

  it('leaves a copy in a mod as it is', () => {
    expect(copyTheGameGets(held(LOOSE, true), PATH, outside)).toEqual(LOOSE);
  });

  it('is asked about the loose file by its own path', () => {
    const asked: string[] = [];
    copyTheGameGets(held(undefined, true), PATH, (path) => { asked.push(path); return true; });
    expect(asked).toEqual(['/game/Data/Textures/Decals/Stain_d.dds']);
  });
});

describe('the game folder\'s archived copy, ranked as the game loads archives', () => {
  const GAME_COPY = { gameRelease: 'Fallout4', archive: '/game/Data/Fallout4 - Textures.ba2', file: PATH };
  const archivedInGame = (modLoadsAfter: boolean): GameFolderArchived => ({
    copies: new Map([[PATH, GAME_COPY]]),
    loadRank: new Map([[GAME_COPY.archive, modLoadsAfter ? 0 : 1], [ARCHIVED.kind === 'archived' ? ARCHIVED.archive : '', modLoadsAfter ? 1 : 0]]),
  });

  it('is the copy when no mod holds one', () => {
    expect(copyTheGameGets(held(undefined, false, true, archivedInGame(true)), PATH, INSIDE)).toEqual({ kind: 'archived', ...GAME_COPY });
  });

  it('loses to a mod\'s archive that loads after it', () => {
    expect(copyTheGameGets(held(ARCHIVED, false, true, archivedInGame(true)), PATH, INSIDE)).toEqual(ARCHIVED);
  });

  it('wins over a mod\'s archive that loads before it', () => {
    expect(copyTheGameGets(held(ARCHIVED, false, true, archivedInGame(false)), PATH, INSIDE)).toEqual({ kind: 'archived', ...GAME_COPY });
  });

  it('loses to a loose copy in a mod, whatever the load order', () => {
    expect(copyTheGameGets(held(LOOSE, false, true, archivedInGame(false)), PATH, INSIDE)).toEqual(LOOSE);
  });

  it('loses to a loose file in the game folder', () => {
    expect(copyTheGameGets(held(undefined, true, true, archivedInGame(false)), PATH, INSIDE)).toEqual({ kind: 'loose', path: '/game/Data/Textures/Decals/Stain_d.dds' });
  });
});
