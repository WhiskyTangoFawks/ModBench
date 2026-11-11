import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ Uri: { file: (path: string) => path }, commands: { executeCommand: () => Promise.resolve() } }));

import { FileConflictLookup, modOrigin, type CopyAt, type StackedFile } from '../../instanceLoader/fileConflictIndex';
import { copyTheGameGets } from '../fileCopy';

const PATH = 'textures/decals/stain_d.dds';
const LOOSE: CopyAt = { kind: 'loose', path: '/instance/mods/Mod/Textures/Decals/Stain_d.dds' };
const ARCHIVED: CopyAt = { kind: 'archived', gameRelease: 'Fallout4', archive: '/instance/mods/Mod/Mod - Textures.ba2', file: PATH };

function held(winner: CopyAt | undefined, inGameFolder = false) {
  const stackedCopies = new FileConflictLookup<StackedFile>();
  if (winner) stackedCopies.set({ relativePath: PATH, copies: [{ origin: modOrigin('Mod'), at: winner }] });
  const files = new Map(inGameFolder ? [[PATH, { relativePath: PATH, path: '/game/Data/Textures/Decals/Stain_d.dds' }]] : []);
  return { stackedCopies, dataFolderFiles: { kind: 'listed' as const, files } };
}

describe('the copy of a file the game gets (symbols.md, The symbols, File)', () => {
  it.each([
    ['a loose copy in a mod', held(LOOSE), LOOSE],
    ['an archived copy in a mod', held(ARCHIVED), ARCHIVED],
    ['a loose copy in a mod, over the game folder\'s', held(LOOSE, true), LOOSE],
    ['the game folder\'s loose copy, over an archived copy in a mod', held(ARCHIVED, true), { kind: 'loose', path: '/game/Data/Textures/Decals/Stain_d.dds' }],
    ['the game folder\'s own copy, when no mod has one', held(undefined, true), { kind: 'loose', path: '/game/Data/Textures/Decals/Stain_d.dds' }],
    ['no copy, when none holds it', held(undefined), undefined],
  ])('is %s', (_case, value, copy) => {
    expect(copyTheGameGets(value, PATH)).toEqual(copy);
  });

  it('is found by a path in any case', () => {
    expect(copyTheGameGets(held(LOOSE), 'Textures/Decals/Stain_D.dds')).toEqual(LOOSE);
  });
});
