import { describe, it, expect } from 'vitest';
import { copiesToRead } from '../copiesToRead';

describe('the copies to read of a file', () => {
  it('names each provider\'s copy by the path its mod holds it at, whatever the case of the file\'s name', () => {
    const value = {
      files: new Map([['textures/shared.dds', { providers: [{ kind: 'mod', name: 'A' }, { kind: 'runtimeOutput' }] as const }]]),
      filesByMod: new Map([['A', [{ relativePath: 'Textures/Shared.dds', sourcePath: '/mods/A/Textures/Shared.dds' }]]]),
      overwriteFiles: [{ relativePath: 'Textures/Shared.dds', sourcePath: '/overwrite/Textures/Shared.dds' }],
    };

    expect(copiesToRead(value, ['textures/shared.dds'])).toEqual([{
      relativePath: 'textures/shared.dds',
      providers: [
        { origin: { kind: 'mod', name: 'A' }, path: '/mods/A/Textures/Shared.dds' },
        { origin: { kind: 'runtimeOutput' }, path: '/overwrite/Textures/Shared.dds' },
      ],
    }]);
  });

  it('keeps Overwrite\'s copy apart from the copy of a mod named overwrite (ADR-0012)', () => {
    const value = {
      files: new Map([['a.dds', { providers: [{ kind: 'runtimeOutput' }, { kind: 'mod', name: 'overwrite' }] as const }]]),
      filesByMod: new Map([['overwrite', [{ relativePath: 'a.dds', sourcePath: '/mods/overwrite/a.dds' }]]]),
      overwriteFiles: [{ relativePath: 'a.dds', sourcePath: '/overwrite/a.dds' }],
    };

    expect(copiesToRead(value, ['a.dds'])[0]?.providers.map(({ path }) => path)).toEqual(['/overwrite/a.dds', '/mods/overwrite/a.dds']);
  });
});
