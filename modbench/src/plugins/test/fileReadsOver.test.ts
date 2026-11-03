import { describe, expect, it, vi } from 'vitest';
import { fileReadsOver } from '../fileReadsOver';

describe('fileReadsOver: the Instance adapter\'s reads, at the file mod order provides', () => {
  const adapter = {
    dataFileChecksum: vi.fn(() => Promise.resolve(7)),
    dataFileVersion: vi.fn(() => Promise.resolve('1.2')),
    dataFileReadable: vi.fn(() => Promise.resolve(true)),
  };
  const winners = { get: (path: string) => (path.toLowerCase() === 'meshes/a.nif' ? { winner: '/mods/M/Meshes/a.nif' } : undefined) };
  const reads = fileReadsOver(adapter, () => winners);

  it('reads the winner of a path a mod provides, in any case and with either slash', async () => {
    await reads.checksum('Meshes\\A.nif');

    expect(adapter.dataFileChecksum).toHaveBeenCalledWith('Meshes/A.nif', '/mods/M/Meshes/a.nif');
  });

  it('reads a path no mod provides from the game folder', async () => {
    await reads.version('../Game.exe', 'product');
    await reads.readable('x.dll');

    expect([adapter.dataFileVersion.mock.calls[0], adapter.dataFileReadable.mock.calls[0]])
      .toEqual([['../Game.exe', undefined, 'product'], ['x.dll', undefined]]);
  });
});
