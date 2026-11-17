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
  it('names for each script the first source the Creation Kit reads that a mod or the Data folder holds, and its compiled script, by Data-relative path', () => {
    const files = filesOf({
      Winning: ['Scripts/Ns/Quest.pex', 'Scripts/Source/Base/Ns/Quest.psc', 'Scripts/Compiled.pex'],
      Losing: ['Scripts/Source/User/Ns/Quest.psc', 'scripts/ns/quest.pex', 'Textures/Quest.pex'],
    });

    expect(papyrusScriptsOf(files, NO_DATA_FOLDER, 'Fallout4')).toEqual([
      { name: 'Compiled', compiledDataPath: 'Scripts/Compiled.pex' },
      { name: 'Ns:Quest', sourceDataPath: 'Scripts/Source/User/Ns/Quest.psc', compiledDataPath: 'Scripts/Ns/Quest.pex' },
    ]);
  });

  it('takes a source the Data folder holds', () => {
    const files = filesOf({ Mod: ['Scripts/Actor.pex'] });

    expect(papyrusScriptsOf(files, dataFolder('Scripts/Source/Base/Actor.psc', 'Scripts/Actor.pex'), 'Fallout4')).toEqual([
      { name: 'Actor', sourceDataPath: 'Scripts/Source/Base/Actor.psc', compiledDataPath: 'Scripts/Actor.pex' },
    ]);
  });

  it('holds a script only an archive holds, with no source', () => {
    expect(papyrusScriptsOf(filesOf({ Mod: ['Scripts/Actor.pex'] }), NO_DATA_FOLDER, 'Fallout4', ['Scripts/Quest.pex', 'Textures/Quest.pex'])).toEqual([
      { name: 'Actor', compiledDataPath: 'Scripts/Actor.pex' },
      { name: 'Quest', compiledDataPath: 'Scripts/Quest.pex' },
    ]);
  });

  it('names none for a release the tables hold no folders for', () => {
    expect(papyrusScriptsOf(filesOf({ Mod: ['Scripts/Quest.pex'] }), NO_DATA_FOLDER, undefined)).toEqual([]);
  });
});
