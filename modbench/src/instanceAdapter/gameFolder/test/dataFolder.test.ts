import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { dataFolderFile } from '../dataFolder';
import type { GameFolder } from '../../instanceAdapter';

const found = (dataFolder: string): GameFolder => ({ kind: 'found', root: '/game', dataFolder });
const NOT_FOUND: GameFolder = { kind: 'notFound', looked: [], setting: 'modbench.mods.gameFolder' };

describe('a file of the game\'s Data folder', () => {
  it.each([
    ['names a file at the root of the Data folder', found('/game/Data'), join('/game', 'Data', 'Fallout4.esm')],
    ['names the same file when the Data folder ends in a separator', found('/game/Data/'), join('/game', 'Data', 'Fallout4.esm')],
    ['names nothing while the game folder is not found', NOT_FOUND, undefined],
  ])('%s', (_, gameFolder, expected) => {
    expect(dataFolderFile(gameFolder, 'Fallout4.esm')).toBe(expected);
  });
});
