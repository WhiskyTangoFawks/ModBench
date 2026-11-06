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

const NO_DATA_FOLDER = { kind: 'unresolved' } as const;
const dataFolder = (...paths: string[]) =>
  ({ kind: 'listed', files: new Map(paths.map((relativePath) => [relativePath.toLowerCase(), { relativePath, path: `/game/Data/${relativePath}` }])) } as const);

describe('papyrusScriptsOf', () => {
  it('places each script at the winning copy of its first source the Creation Kit reads, and of its compiled script', () => {
    const files = filesOf({
      Winning: ['Scripts/Ns/Quest.pex', 'Scripts/Source/Base/Ns/Quest.psc', 'Scripts/Compiled.pex'],
      Losing: ['Scripts/Source/User/Ns/Quest.psc', 'scripts/ns/quest.pex', 'Textures/Quest.pex'],
    });

    expect(papyrusScriptsOf(files, NO_DATA_FOLDER, 'Fallout4')).toEqual([
      { name: 'Compiled', compiled: '/mods/Winning/Scripts/Compiled.pex' },
      { name: 'Ns:Quest', source: '/mods/Losing/Scripts/Source/User/Ns/Quest.psc', compiled: '/mods/Winning/Scripts/Ns/Quest.pex' },
    ]);
  });

  it('takes a script the Data folder holds at the folder\'s own spelling, below every mod\'s copy', () => {
    const files = filesOf({ Mod: ['Scripts/Actor.pex'] });

    expect(papyrusScriptsOf(files, dataFolder('Scripts/Source/Base/Actor.psc', 'Scripts/Actor.pex'), 'Fallout4')).toEqual([
      { name: 'Actor', source: '/game/Data/Scripts/Source/Base/Actor.psc', compiled: '/mods/Mod/Scripts/Actor.pex' },
    ]);
  });

  it('names none for a release the tables hold no folders for', () => {
    expect(papyrusScriptsOf(filesOf({ Mod: ['Scripts/Quest.pex'] }), NO_DATA_FOLDER, undefined)).toEqual([]);
  });
});
