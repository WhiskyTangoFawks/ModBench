import { describe, expect, it } from 'vitest';
import { folderValueOver, modValueOver } from '../modValue';

const stamp = { size: 0n, modifiedNs: 0n, changedNs: 0n };

const reads = (held: readonly string[], findsOtherCase = false) => ({
  filesIn: () => Promise.resolve(held),
  originFileHash: (path: string) => Promise.resolve({ kind: 'read' as const, answer: { size: 1, hash: `h:${path}` } }),
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

    expect(value.kind === 'read' && [[...value.packageEntries.keys()], [...value.downloadedFiles.keys()]]).toEqual([['H1'], ['Mod.zip']]);
  });

  it('is unreadable, saying why, when a read rejects, and keeps its metadata', async () => {
    const value = await modValueOver({ ...modReads, filesIn: () => Promise.reject(new Error('EACCES')) }, 'Mod', '/mods/Mod', { entries: [], installationFiles: [] });

    expect(value).toEqual({ metadata: { kind: 'read', answer: {} }, kind: 'unreadable', reason: 'EACCES' });
  });
});
