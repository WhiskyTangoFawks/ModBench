import { describe, it, expect } from 'vitest';
import type { FolderFile, FolderValue } from '../../repositoriesLib/statusValues';
import type { Manifest } from '../manifest';
import { flaggedFilesIn, flaggedHashesFrom, flaggedHashesIn, type PossibleHashes } from '../flaggedHashes';
import { localFailure } from '../../wire/readFailed';

const manifest: Manifest = {
  packages: [], exclude: [], ignore: [],
  flags: new Map([['Mod.esp', { Small: true }], ['Gone.esp', { Small: true }]]),
  files: new Map([['Mod.esp', 'AAAAAAAAAAA='], ['Gone.esp', 'BBBBBBBBBBA='], ['a.nif', 'CCCCCCCCCCA=']]),
};

const file = (path: string): FolderFile =>
  ({ path, excluded: false, read: { kind: 'read', answer: { hash: 'DDDDDDDDDDA=' } } });
const folder: FolderValue = {
  files: new Map([['Mod.esp', file('Mod.esp')], ['a.nif', file('a.nif')]]), exclude: [], ignoresCase: false,
};

describe('the hashes a folder\'s flagged plugins could have had before their flags', () => {
  it('asks for each flagged plugin the folder holds, by its path there, and answers them by manifest path', async () => {
    const asked: Parameters<PossibleHashes>[0][] = [];
    const possible: PossibleHashes = (files) => {
      asked.push(files);
      return Promise.resolve(files.map(({ path }) => ({ path, hashes: ['AAAAAAAAAAA='] })));
    };

    const answer = await flaggedHashesIn(manifest, folder, '/mods/Mod', possible);

    expect([asked, answer]).toEqual([[[{ path: '/mods/Mod/Mod.esp', flags: { Small: true } }]], new Map([['Mod.esp', ['AAAAAAAAAAA=']]])]);
  });

  it('asks nothing when the folder holds no flagged plugin', async () => {
    const possible: PossibleHashes = () => Promise.reject(new Error('asked'));

    expect(await flaggedHashesIn(manifest, { ...folder, files: new Map([['a.nif', file('a.nif')]]) }, '/mods/Mod', possible)).toEqual(new Map());
  });

  it('cannot tell, saying why, when mEdit cannot answer', async () => {
    const answer = await flaggedHashesIn(manifest, folder, '/mods/Mod', () => Promise.resolve(localFailure('mEdit is not running')));

    expect('cannotTell' in answer && answer.cannotTell).toContain('mEdit is not running');
  });

  it('cannot tell when it has no way to ask mEdit', async () => {
    expect(await flaggedHashesIn(manifest, folder, '/mods/Mod', undefined)).toEqual({ cannotTell: 'its manifest sets flags, which need mEdit' });
  });

  it('cannot tell when mEdit leaves a plugin it was asked about unanswered', async () => {
    const answer = await flaggedHashesIn(manifest, folder, '/mods/Mod', () => Promise.resolve([]));

    expect('cannotTell' in answer && answer.cannotTell).toContain('Mod.esp');
  });

  describe('what a held answer says of the flagged plugins a folder holds', () => {
    const files = flaggedFilesIn(manifest, folder, '/mods/Mod');

    it('names the hashes of each, by manifest path', () => {
      expect(flaggedHashesFrom(files, () => ({ kind: 'read', answer: ['AAAAAAAAAAA='] }))).toEqual(new Map([['Mod.esp', ['AAAAAAAAAAA=']]]));
    });

    it.each([
      ['a file mEdit could not read', { kind: 'unreadable' as const, reason: 'EACCES' }, 'could not be read: EACCES'],
      ['a file mEdit has not answered for', { kind: 'unanswered' as const }, 'has not said'],
      ['a file nothing was asked of', undefined, 'has not said'],
    ])('cannot tell for %s', (_what, read, why) => {
      const answer = flaggedHashesFrom(files, () => read);

      expect('cannotTell' in answer && answer.cannotTell).toContain(why);
    });
  });
});
