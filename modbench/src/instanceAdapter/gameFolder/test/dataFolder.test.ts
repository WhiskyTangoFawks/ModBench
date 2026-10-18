import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { dataFolderFile } from '../dataFolder';

describe('dataFolderFile', () => {
  it('names a file at the root of the Data folder of a game folder found', () => {
    const found = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
    expect(dataFolderFile(found, 'Fallout4.esm')).toBe(join('/game', 'Data', 'Fallout4.esm'));
  });

  it('names the same file when the Data folder setting ends in a separator', () => {
    const found = { kind: 'found', root: '/game', dataFolder: '/game/Data/' } as const;
    expect(dataFolderFile(found, 'Fallout4.esm')).toBe(join('/game', 'Data', 'Fallout4.esm'));
  });

  it('names nothing while the game folder is not found', () => {
    const notFound = { kind: 'notFound', looked: [], setting: 'modbench.mods.gameDirectory' } as const;
    expect(dataFolderFile(notFound, 'Fallout4.esm')).toBeUndefined();
  });
});
