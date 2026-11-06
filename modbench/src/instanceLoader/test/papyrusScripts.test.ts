import { describe, it, expect } from 'vitest';
import { buildFileConflictIndex } from '../fileConflictIndex';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { fileIn } from '../../test/fakeInstanceAdapter';
import { papyrusScriptsOf } from '../papyrusScripts';

const filesOf = (filesByMod: Record<string, string[]>) => {
  const entries: ModlistEntry[] = Object.keys(filesByMod).map((name) => ({ kind: 'mod', name, enabled: true }));
  return buildFileConflictIndex(entries, [], new Map(Object.entries(filesByMod).map(([name, paths]) => [name, {
    origin: name, folder: `/mods/${name}`, folders: [], notes: [], files: paths.map((path) => fileIn(`/mods/${name}`, path)),
  }]))).files;
};

describe('papyrusScriptsOf', () => {
  it('names each script once, at its source in the first source folder that holds one, else at its compiled script', () => {
    const files = filesOf({
      Winning: ['Scripts/Ns/Quest.pex', 'Scripts/Source/Base/Ns/Quest.psc', 'Scripts/Compiled.pex'],
      Losing: ['Scripts/Source/User/Ns/Quest.psc', 'Textures/Quest.pex'],
    });

    expect(papyrusScriptsOf(files, 'Fallout4')).toEqual([
      { name: 'Compiled', file: '/mods/Winning/Scripts/Compiled.pex' },
      { name: 'Ns:Quest', file: '/mods/Losing/Scripts/Source/User/Ns/Quest.psc' },
    ]);
  });

  it('names none for a release the tables hold no row for', () => {
    expect(papyrusScriptsOf(filesOf({ Mod: ['Scripts/Quest.pex'] }), undefined)).toEqual([]);
  });
});
