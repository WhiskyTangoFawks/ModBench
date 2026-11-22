import { describe, expect, it, vi } from 'vitest';
import { fileReadsOver } from '../plugins';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';

describe('fileReadsOver: the Instance adapter\'s reads, at the path each is placed at', () => {
  const { adapter } = fakeInstanceAdapter(undefined, {
    dataFiles: new Map([
      ['/mods/M/Meshes/a.nif', { checksum: 7 }],
      ['../Game.exe', { version: '1.2', readable: true }],
    ]),
  });
  const places = new Map<string, string | null>([['Meshes/A.nif', '/mods/M/Meshes/a.nif'], ['Meshes/none.nif', null]]);
  const reads = fileReadsOver(adapter, (path) => places.get(path));

  it('reads the file at the path it is placed at, with either slash', async () => {
    expect(await reads.checksum('Meshes\\A.nif')).toEqual({ kind: 'read', value: 7 });
  });

  it('answers a file nothing holds as not there, asking the adapter nothing', async () => {
    const asked = vi.spyOn(adapter, 'dataFileChecksum');

    expect([await reads.checksum('Meshes/none.nif'), await reads.version('Meshes/none.nif', 'file'), await reads.readable('Meshes/none.nif')])
      .toEqual([{ kind: 'read', value: undefined }, { kind: 'read', value: undefined }, { kind: 'read', value: false }]);
    expect(asked).not.toHaveBeenCalled();
  });

  it('leaves the adapter to find a file it does not place in the game folder', async () => {
    expect([await reads.version('../Game.exe', 'file'), await reads.readable('../Game.exe')])
      .toEqual([{ kind: 'read', value: '1.2' }, { kind: 'read', value: true }]);
  });
});
