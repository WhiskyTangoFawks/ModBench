import { describe, expect, it } from 'vitest';
import { fileReadsOver } from '../plugins';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';

describe('fileReadsOver: the Instance adapter\'s reads, at the file mod order provides', () => {
  const { adapter } = fakeInstanceAdapter(undefined, {
    dataFiles: new Map([
      ['/mods/M/Meshes/a.nif', { checksum: 7 }],
      ['Meshes/A.nif', { checksum: 9 }],
      ['../Game.exe', { version: '1.2', readable: true }],
    ]),
  });
  const winners = { get: (path: string) => (path.toLowerCase() === 'meshes/a.nif' ? { winner: '/mods/M/Meshes/a.nif' } : undefined) };
  const reads = fileReadsOver(adapter, () => winners);

  it('reads the winner of a path a mod provides, in any case and with either slash', async () => {
    expect(await reads.checksum('Meshes\\A.nif')).toEqual({ kind: 'read', value: 7 });
  });

  it('reads a path no mod provides from the game folder', async () => {
    expect([await reads.version('../Game.exe', 'file'), await reads.readable('../Game.exe')])
      .toEqual([{ kind: 'read', value: '1.2' }, { kind: 'read', value: true }]);
  });
});
