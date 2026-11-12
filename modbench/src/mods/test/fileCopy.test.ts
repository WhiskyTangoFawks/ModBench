import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri, TreeItem, TreeItemCollapsibleState, commands: { executeCommand: () => Promise.resolve() } }));

import { FileConflictLookup, modOrigin, type CopyAt, type StackedFile } from '../../instanceLoader/fileConflictIndex';
import { copyTheGameGets } from '../fileCopy';

const PATH = 'textures/decals/stain_d.dds';
const LOOSE: CopyAt = { kind: 'loose', path: '/instance/mods/Mod/Textures/Decals/Stain_d.dds' };
const ARCHIVED: CopyAt = { kind: 'archived', gameRelease: 'Fallout4', archive: '/instance/mods/Mod/Mod - Textures.ba2', file: PATH };

function held(winner: CopyAt | undefined, inGameFolder = false, listed = true) {
  const stackedCopies = new FileConflictLookup<StackedFile>();
  if (winner) stackedCopies.set({ relativePath: PATH, copies: [{ origin: modOrigin('Mod'), at: winner }] });
  const files = new Map(inGameFolder ? [[PATH, { relativePath: PATH, path: '/game/Data/Textures/Decals/Stain_d.dds' }]] : []);
  return { stackedCopies, dataFolderFiles: listed ? { kind: 'listed' as const, files } : { kind: 'unresolved' as const } };
}

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
    expect(copyTheGameGets(value, PATH)).toEqual(copy);
  });

  it('is found by a path in any case', () => {
    expect(copyTheGameGets(held(LOOSE), 'Textures/Decals/Stain_D.dds')).toEqual(LOOSE);
  });
});
