import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import { status } from '../../test/modStatusFixture';
import { statusProblems } from '../statusProblems';

const folder = join('/instance', 'mods', 'Mod');
const manifestFile = join(folder, 'MOD.Manifest.json');
const held = (over: Partial<ModStatus>): ModStatus => status('Mod', { manifestFile, ...over });

describe('a mod\'s unfinished states, each on the file it concerns (instance-repository.md, Status, story 2)', () => {
  it('has none for a folder that matches its manifest', () => {
    expect(statusProblems(held({}), folder)).toEqual([]);
  });

  it('puts a manifest that cannot be read on the manifest, saying why', () => {
    expect(statusProblems(held({ unreadable: "its manifest flags 'a.txt', which is no plugin" }), folder))
      .toEqual([{ file: manifestFile, message: "Its manifest flags 'a.txt', which is no plugin." }]);
  });

  it('puts a mod with no manifest on its folder, and nothing else', () => {
    expect(statusProblems(status('Mod', { noManifest: true }), folder)).toEqual([{ file: folder, message: 'No manifest.' }]);
  });

  it.each([
    ['with a manifest', held({ installationFileProblem: 'this machine does not hold A.7z, the file it is installed from' })],
    ['with none', status('Mod', { noManifest: true, installationFileProblem: 'this machine does not hold A.7z, the file it is installed from' })],
  ])('puts an installation file the mod manager names that is missing or unreadable on the folder, %s', (_manifest, mod) => {
    expect(statusProblems(mod, folder)).toContainEqual({ file: folder, message: 'this machine does not hold A.7z, the file it is installed from' });
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
    ['a repository with no pin', { unpinned: ["repository 'Mod'"] }, "Repository 'Mod' is not pinned: the instance repository pins no commit for it until its gitlink is staged."],
    ['a package this machine lacks', { packagesLacking: ['the game folder was not found'] }, 'This machine does not hold a package it names: the game folder was not found.'],
  ])('puts %s on the manifest, as the folder spells it', (_state, over, message) => {
    expect(statusProblems(held(over), folder)).toEqual([{ file: manifestFile, message }]);
  });

  it.each([
    ['with a manifest', held({})],
    ['with none', status('Mod', { noManifest: true })],
    ['held whole by git', status('Mod', { heldWhole: true })],
  ])('puts each path its build file names that the source folder lacks, and each it cannot read, on the build file, %s', (_manifest, mod) => {
    const file = join('/instance', 'source', 'Mod', 'build.json');
    const buildFile = {
      file, lacks: [{ step: 'compile', path: 'Old.esp' }, { step: 'copy', path: 'meshes' }] as const, unreadable: ["'locked' could not be read: EACCES"],
    };

    expect(statusProblems({ ...mod, buildFile }, folder).filter((problem) => problem.file === file)).toEqual([
      { file, message: "Its compile step names 'Old.esp', whose plugin source the source folder lacks." },
      { file, message: "Its copy step names 'meshes', which the source folder lacks." },
      { file, message: "'locked' could not be read: EACCES." },
    ]);
  });
});
