import { describe, it, expect } from 'vitest';
import type { FolderFile, FolderValue } from '../../repositoriesLib/statusValues';
import type { Manifest } from '../manifest';
import { flaggedHashesIn, type PossibleHashes } from '../flaggedHashes';
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

    expect(answer).toEqual({ cannotTell: expect.stringContaining('mEdit is not running') as string });
  });

  it('cannot tell when mEdit leaves a plugin it was asked about unanswered', async () => {
    const answer = await flaggedHashesIn(manifest, folder, '/mods/Mod', () => Promise.resolve([]));

    expect(answer).toEqual({ cannotTell: expect.stringContaining('Mod.esp') as string });
  });
});
