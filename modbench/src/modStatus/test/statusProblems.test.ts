import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import { status } from '../../test/modStatusFixture';
import { statusProblems } from '../statusProblems';

const folder = join('/instance', 'mods', 'Mod');
const manifestFile = join(folder, 'MOD.Manifest.json');
const held = (over: Partial<ModStatus>): ModStatus => status('Mod', { manifestFile, ...over });

describe('a mod\'s unfinished states, each on the file it concerns (modlist-repository.md, Status, story 2)', () => {
  it('has none for a folder that matches its manifest', () => {
    expect(statusProblems(held({}), folder)).toEqual([]);
  });

  it('puts a mod with no manifest on its folder, and nothing else', () => {
    expect(statusProblems(status('Mod', { noManifest: true }), folder)).toEqual([{ file: folder, message: 'No manifest.' }]);
  });

  it.each([
    ['a file that differs', { differing: ['a.nif'] }, 'a.nif', 'Differs from its manifest.'],
    ['a file no line names', { namedByNoLine: ['mine.txt'] }, 'mine.txt', 'No line of the mod\'s manifest names this file.'],
  ])('puts %s on that file', (_state, over, path, message) => {
    expect(statusProblems(held(over), folder)).toEqual([{ file: join(folder, path), message }]);
  });

  it.each([
    ['a file that is gone', { gone: ['b.nif'] }, "Names 'b.nif', which the mod's folder lacks."],
    ['a file no package holds', { notInPackage: ['b.esp'] }, "No package it names holds the bytes of 'b.esp'."],
    ['a file a package holds one of its name of with other bytes', { otherBytes: ['b.esp'] }, "No package it names holds the bytes of 'b.esp'; one holds a file of its name."],
    ['a package with no host', { noHost: ['the game folder'] }, 'The game folder has no host.'],
    ['a package this machine lacks', { packagesLacking: ['the game folder was not found'] }, 'This machine does not hold a package it names: the game folder was not found.'],
  ])('puts %s on the manifest, as the folder spells it', (_state, over, message) => {
    expect(statusProblems(held(over), folder)).toEqual([{ file: manifestFile, message }]);
  });
});
