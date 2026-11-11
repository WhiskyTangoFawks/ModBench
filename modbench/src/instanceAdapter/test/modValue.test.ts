import { describe, expect, it } from 'vitest';
import { folderValueOver, modValueOver, unheldFolderValueOver } from '../modValue';

const stamp = { size: 0n, modifiedNs: 0n };

const reads = (held: readonly string[], findsOtherCase = false) => ({
  filesIn: () => Promise.resolve(held),
  originFileHash: (path: string) => Promise.resolve({ kind: 'read' as const, answer: { size: 1, hash: `h:${path.replaceAll('\\', '/')}` } }),
  fileStamp: (path: string) => Promise.resolve(findsOtherCase ? { kind: 'read' as const, answer: stamp } : { kind: 'unreadable' as const, reason: `ENOENT ${path}` }),
  exclusionMark: '.mohidden',
});

describe('a folder as a value', () => {
  it('holds every file it lists with its own path, whether the mark excludes it, and its hash', async () => {
    const { files } = await folderValueOver(reads(['a.esp', 'meshes.mohidden/b.nif']), '/mods/Mod');

    expect([...files]).toEqual([
      ['a.esp', { path: 'a.esp', excluded: false, read: { kind: 'read', answer: { size: 1, hash: 'h:/mods/Mod/a.esp' } } }],
      ['meshes.mohidden/b.nif', { path: 'meshes/b.nif', excluded: true, read: { kind: 'read', answer: { size: 1, hash: 'h:/mods/Mod/meshes.mohidden/b.nif' } } }],
    ]);
  });

  it('excludes each path the mark excludes, a folder by its own path, once', async () => {
    const { exclude } = await folderValueOver(reads(['a.esp.mohidden', 'docs.mohidden/a.txt', 'docs.mohidden/b.txt', 'c.esp']), '/mods/Mod');

    expect(exclude).toEqual(['a.esp', 'docs']);
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

describe('a folder\'s files git does not hold as a value', () => {
  it('holds only the files git neither holds nor owns, an attributes file git does not hold among them', async () => {
    const { files } = await unheldFolderValueOver(
      reads(['.git/config', '.gitattributes', '.gitignore', 'build.json', 'textures/a.dds']), ['.gitignore', 'build.json'], '/source/Mod',
    );

    expect([...files.keys()]).toEqual(['.gitattributes', 'textures/a.dds']);
  });
});

describe('a mod as a value', () => {
  const PLACE = { root: '/game', depots: [], depotProblems: [] };
  const modReads = {
    ...reads(['a.esp']),
    downloadedFile: () => Promise.resolve({ kind: 'read' as const, answer: undefined }),
    gamePlaces: () => Promise.resolve([]),
    gameFilesTakenBy: () => Promise.resolve({ kind: 'read' as const, answer: { gameFiles: [], notes: [] } }),
    submodule: (name: string) => Promise.resolve(name === 'Hosted' ? { folder: '/source/Hosted', pin: 'abc' } : name === 'Unpinned' ? { lacks: 'no pin', unpinned: true as const } : { lacks: 'no submodule' }),
    sourceFolderTracked: (name: string) => Promise.resolve(name === 'Tracked'),
  };

  it('holds each downloaded file asked for', async () => {
    const value = await modValueOver(modReads, '/mods/Mod', { installationFiles: ['Mod.zip'] }, []);

    if (value.kind !== 'read') throw new Error('expected the values to read');
    expect([...value.downloadedFiles.keys()]).toEqual(['Mod.zip']);
  });

  it('reads no game file when the game folder is not found', async () => {
    const value = await modValueOver(modReads, '/mods/Mod', { installationFiles: [], gameFiles: ['a.esp'] }, []);

    expect(value).toMatchObject({ kind: 'read', gameFiles: undefined });
  });

  it.each([['Hosted', 'pinned'], ['Tracked', 'pinned'], ['Unpinned', 'unpinned'], ['Local', 'none']])('says what a clone gets of the repository %s: a submodule at a pinned commit, an unpinned one, or a source folder the instance repository tracks', async (repository, repositoryPin) => {
    const value = await modValueOver(modReads, '/mods/Mod', { installationFiles: [], repository }, []);

    expect(value).toMatchObject({ kind: 'read', repositoryPin });
  });

  it('reads and hashes no file of a folder when no manifest is asked for', async () => {
    const hashed: string[] = [];
    const value = await modValueOver({ ...modReads, originFileHash: (path: string) => { hashed.push(path); return modReads.originFileHash(path); } }, '/mods/Mod', undefined, []);

    expect([value.kind, hashed]).toEqual(['notAsked', []]);
  });

  it('is unreadable, saying why, when the game files cannot be read', async () => {
    const reading = { ...modReads, gamePlaces: () => Promise.resolve([PLACE]), gameFilesTakenBy: () => Promise.resolve({ kind: 'unreadable' as const, reason: 'EACCES' }) };

    expect(await modValueOver(reading, '/mods/Mod', { installationFiles: [], gameFiles: ['a.esp'] }, [])).toEqual({ kind: 'unreadable', reason: 'EACCES' });
  });

  it('is unreadable, saying why, when a read rejects', async () => {
    const value = await modValueOver({ ...modReads, filesIn: () => Promise.reject(new Error('EACCES')) }, '/mods/Mod', { installationFiles: [] }, []);

    expect(value).toEqual({ kind: 'unreadable', reason: 'EACCES' });
  });
});
