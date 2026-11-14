import { describe, expect, it } from 'vitest';
import { gameFolderFile } from '../modFileStates';

const PATH = 'textures/decals/stain_d.dds';
const GAME_LOOSE_PATH = '/game/Data/Textures/Decals/Stain_d.dds';

describe('a loose file in the game folder\'s Data folder', () => {
  it('is found by a path spelled with backslashes', () => {
    const dataFolderFiles = { kind: 'listed' as const, files: new Map([[PATH, { relativePath: PATH, path: GAME_LOOSE_PATH }]]) };

    expect(gameFolderFile({ dataFolderFiles }, 'Textures\\Decals\\Stain_d.dds')).toBe(GAME_LOOSE_PATH);
  });
});
