import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri, TreeItem, TreeItemCollapsibleState, commands: { executeCommand: () => Promise.resolve() } }));

import { FileConflictLookup, modOrigin, NO_GAME_FOLDER_ARCHIVED, type CopyAt, type GameFolderArchived, type StackedFile } from '../../instanceLoader/fileConflictIndex';
import { copyTheGameGets } from '../fileCopy';

const PATH = 'textures/decals/stain_d.dds';
const GAME_LOOSE_PATH = '/game/Data/Textures/Decals/Stain_d.dds';
const MOD_ARCHIVE = '/instance/mods/Mod/Mod - Textures.ba2';
const LOOSE: CopyAt = { kind: 'loose', path: '/instance/mods/Mod/Textures/Decals/Stain_d.dds' };
const ARCHIVED: CopyAt = { kind: 'archived', gameRelease: 'Fallout4', archive: MOD_ARCHIVE, file: PATH };
const GAME_COPY = { gameRelease: 'Fallout4', archive: '/game/Data/Fallout4 - Textures.ba2', file: PATH };
const GAME_ARCHIVED: CopyAt = { kind: 'archived', ...GAME_COPY };
const GAME_LOOSE: CopyAt = { kind: 'loose', path: GAME_LOOSE_PATH };

const gameLoadsFirst: GameFolderArchived = { copies: new Map([[PATH, GAME_COPY]]), loadRank: new Map([[GAME_COPY.archive, 0], [MOD_ARCHIVE, 1]]) };
const gameLoadsLast: GameFolderArchived = { copies: new Map([[PATH, GAME_COPY]]), loadRank: new Map([[GAME_COPY.archive, 1], [MOD_ARCHIVE, 0]]) };

interface Held {
  winner?: CopyAt;
  gameLoose?: true;
  dataFolderUnlisted?: true;
  gameFolderArchived?: GameFolderArchived;
  outsideWorkspace?: true;
}

function held({ winner, gameLoose, dataFolderUnlisted, gameFolderArchived = NO_GAME_FOLDER_ARCHIVED, outsideWorkspace }: Held) {
  const stackedCopies = new FileConflictLookup<StackedFile>();
  if (winner) stackedCopies.set({ relativePath: PATH, copies: [{ origin: modOrigin('Mod'), at: winner }] });
  const files = new Map(gameLoose ? [[PATH, { relativePath: PATH, path: GAME_LOOSE_PATH }]] : []);
  return {
    stackedCopies, gameFolderArchived, gameFolderInWorkspace: outsideWorkspace === undefined,
    dataFolderFiles: dataFolderUnlisted ? { kind: 'unresolved' as const } : { kind: 'listed' as const, files },
  };
}

const NOT_FOUND = { none: `No enabled mod, Overwrite or loose file in the Data folder holds ${PATH}.` };
const OUTSIDE = { none: `${PATH} is in the game folder, which is outside the workspace.` };

describe('the copy of a file the game gets (symbols.md, The symbols, File)', () => {
  it.each([
    ['a loose copy in a mod', { winner: LOOSE }, LOOSE],
    ['an archived copy in a mod', { winner: ARCHIVED }, ARCHIVED],
    ['a loose copy in a mod, over the game folder\'s', { winner: LOOSE, gameLoose: true }, LOOSE],
    ['the game folder\'s loose copy, over an archived copy in a mod', { winner: ARCHIVED, gameLoose: true }, GAME_LOOSE],
    ['the game folder\'s own copy, when no mod has one', { gameLoose: true }, GAME_LOOSE],
    ['what was searched, when no mod or Data folder file holds it', {}, NOT_FOUND],
    ['what was searched, when the Data folder cannot be listed', { dataFolderUnlisted: true }, { none: `No enabled mod or Overwrite holds ${PATH}, and the Data folder's files could not be listed.` }],
  ] as const)('is %s', (_case, value: Held, copy) => {
    expect(copyTheGameGets(held(value), PATH)).toEqual(copy);
  });

  it('is found by a path in any case', () => {
    expect(copyTheGameGets(held({ winner: LOOSE }), 'Textures/Decals/Stain_D.dds')).toEqual(LOOSE);
  });
});

describe('a game folder outside the workspace is never a definition (ADR-0001)', () => {
  it.each([
    ['its loose file', { gameLoose: true }, OUTSIDE],
    ['its loose file, which wins over an archived copy in a mod, so that copy is not the answer', { winner: ARCHIVED, gameLoose: true }, OUTSIDE],
    ['an archived copy in a mod, when the game folder holds no loose file', { winner: ARCHIVED }, ARCHIVED],
    ['a loose copy in a mod', { winner: LOOSE, gameLoose: true }, LOOSE],
  ] as const)('%s', (_case, value: Held, copy) => {
    expect(copyTheGameGets(held({ ...value, outsideWorkspace: true }), PATH)).toEqual(copy);
  });
});

describe('the game folder\'s archived copy, ranked as the game loads archives', () => {
  it.each([
    ['is the copy when no mod holds one', { gameFolderArchived: gameLoadsFirst }, GAME_ARCHIVED],
    ['loses to a mod\'s archive that loads after it', { winner: ARCHIVED, gameFolderArchived: gameLoadsFirst }, ARCHIVED],
    ['wins over a mod\'s archive that loads before it', { winner: ARCHIVED, gameFolderArchived: gameLoadsLast }, GAME_ARCHIVED],
    ['loses to a loose copy in a mod, whatever the load order', { winner: LOOSE, gameFolderArchived: gameLoadsLast }, LOOSE],
    ['loses to a loose file in the game folder', { gameLoose: true, gameFolderArchived: gameLoadsLast }, GAME_LOOSE],
  ] as const)('%s', (_case, value: Held, copy) => {
    expect(copyTheGameGets(held(value), PATH)).toEqual(copy);
  });

  it('refuses to rank a mod archive the load order does not hold', () => {
    const unranked: GameFolderArchived = { copies: gameLoadsFirst.copies, loadRank: new Map([[GAME_COPY.archive, 0]]) };

    expect(() => copyTheGameGets(held({ winner: ARCHIVED, gameFolderArchived: unranked }), PATH)).toThrow(MOD_ARCHIVE);
  });
});
