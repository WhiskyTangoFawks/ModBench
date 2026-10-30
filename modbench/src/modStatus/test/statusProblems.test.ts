import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { status } from '../../test/modStatusFixture';
import { statusProblems } from '../statusProblems';

const folder = join('/instance', 'mods', 'Mod');
const manifest = join(folder, 'Mod.manifest.json');

describe('a mod\'s unfinished states, each on the file it concerns (modlist-repository.md, Status, story 2)', () => {
  it('has none for a folder that matches its manifest', () => {
    expect(statusProblems(status('Mod'), folder)).toEqual([]);
  });

  it('puts a mod with no manifest on its folder, and nothing else', () => {
    expect(statusProblems(status('Mod', { noManifest: true }), folder)).toEqual([{ file: folder, message: 'No manifest.' }]);
  });

  it('puts a file that differs and a file no line names on that file', () => {
    const problems = statusProblems(status('Mod', { differing: ['a.nif'], namedByNoLine: ['mine.txt'] }), folder);

    expect(problems.map(({ file }) => file)).toEqual([join(folder, 'a.nif'), join(folder, 'mine.txt')]);
  });

  it.each([
    ['a file that is gone', { gone: ['b.nif'] }],
    ['a file no package holds', { notInPackage: ['b.esp'] }],
    ['a file a package holds with other bytes', { otherBytes: ['b.esp'] }],
    ['metadata that differs', { metadataDiffers: true }],
    ['a package with no host', { noHost: true }],
    ['a package missing from this machine', { packagesMissing: ["installation file 'Mod.zip' is missing"] }],
  ])('puts %s on the mod\'s manifest', (_state, over) => {
    const problems = statusProblems(status('Mod', over), folder);

    expect([problems.length, ...problems.map(({ file }) => file)]).toEqual([1, manifest]);
  });

  it('says which package is missing and why', () => {
    const [problem] = statusProblems(status('Mod', { packagesMissing: ['the game folder was not found'] }), folder);

    expect(problem?.message).toBe('A package it pins is missing from this machine: the game folder was not found.');
  });
});
