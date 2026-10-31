import { describe, expect, it } from 'vitest';
import { folderValueOver, modValueOver } from '../modValue';

const stamp = { size: 0n, modifiedNs: 0n, changedNs: 0n };

const reads = (held: readonly string[], findsOtherCase = false) => ({
  filesIn: () => Promise.resolve(held),
  originFileHash: (path: string) => Promise.resolve({ kind: 'read' as const, answer: { size: 1, hash: `h:${path.replaceAll('\\', '/')}` } }),
  fileStamp: (path: string) => Promise.resolve(findsOtherCase ? { kind: 'read' as const, answer: stamp } : { kind: 'unreadable' as const, reason: `ENOENT ${path}` }),
});

describe('a folder as a value', () => {
  it('holds every file it lists with its hash', async () => {
    const { files } = await folderValueOver(reads(['a.esp', 'meshes/b.nif']), '/mods/Mod');

    expect([...files]).toEqual([
      ['a.esp', { kind: 'read', answer: { size: 1, hash: 'h:/mods/Mod/a.esp' } }],
      ['meshes/b.nif', { kind: 'read', answer: { size: 1, hash: 'h:/mods/Mod/meshes/b.nif' } }],
    ]);
  });

  it.each([[true], [false]])('says its file system ignores case when it finds a file by a name in another case: %s', async (finds) => {
    expect((await folderValueOver(reads(['a.esp'], finds), '/mods/Mod')).ignoresCase).toBe(finds);
  });

  it('says its file system does not ignore case when it lists two names that differ only in case', async () => {
    expect((await folderValueOver(reads(['a.txt', 'A.TXT'], true), '/mods/Mod')).ignoresCase).toBe(false);
  });

  it('says its file system does not ignore case when no file name has a case to change', async () => {
    expect((await folderValueOver(reads(['123.456'], true), '/mods/Mod')).ignoresCase).toBe(false);
  });
});

describe('a mod as a value', () => {
  const modReads = {
    ...reads(['a.esp']),
    modMetadata: () => Promise.resolve({ kind: 'read' as const, answer: {} }),
    packageEntries: (hash: string) => Promise.resolve(hash === 'H1' ? new Map([['a.esp', 'x']]) : undefined),
    downloadedFile: () => Promise.resolve({ kind: 'read' as const, answer: undefined }),
    gameFolder: () => Promise.resolve({ kind: 'notFound' as const, looked: [], setting: '' }),
  };

  it('holds the entries of the packages asked that the index holds', async () => {
    const value = await modValueOver(modReads, 'Mod', '/mods/Mod', { entries: ['H1', 'H2'], installationFiles: ['Mod.zip'] });

    if (value.kind !== 'read') throw new Error('expected the values to read');
    expect([[...value.packageEntries.keys()], [...value.downloadedFiles.keys()]]).toEqual([['H1'], ['Mod.zip']]);
  });

  it('reads and hashes no file of a folder when no manifest is asked for', async () => {
    const hashed: string[] = [];
    const value = await modValueOver({ ...modReads, originFileHash: (path: string) => { hashed.push(path); return modReads.originFileHash(path); } }, 'Mod', '/mods/Mod', undefined);

    expect([value.kind, hashed]).toEqual(['metadataOnly', []]);
  });

  it('reads and hashes no file of a folder whose metadata cannot be read', async () => {
    const hashed: string[] = [];
    const reading = { ...modReads, modMetadata: () => Promise.resolve({ kind: 'unreadable' as const, reason: 'EACCES' }), originFileHash: (path: string) => { hashed.push(path); return modReads.originFileHash(path); } };

    expect([(await modValueOver(reading, 'Mod', '/mods/Mod', { entries: [], installationFiles: [] })).kind, hashed]).toEqual(['metadataOnly', []]);
  });

  it('is unreadable, saying why, when a read rejects, and keeps its metadata', async () => {
    const value = await modValueOver({ ...modReads, filesIn: () => Promise.reject(new Error('EACCES')) }, 'Mod', '/mods/Mod', { entries: [], installationFiles: [] });

    expect(value).toEqual({ metadata: { kind: 'read', answer: {} }, kind: 'unreadable', reason: 'EACCES' });
  });
});
