import { describe, it, expect, afterEach } from 'vitest';
import type { DataFolderFiles, InstanceReading } from '../../instanceAdapter/instanceAdapter';
import { fileIn } from '../../test/fakeInstanceAdapter';
import type { PapyrusScript } from '../instance';
import { disposeLoaded, loader } from './loader';

afterEach(disposeLoaded);

const modsHolding = (filesByMod: Record<string, string[]>): Partial<InstanceReading> => ({
  mods: Object.keys(filesByMod).map((name) => ({ kind: 'mod', name, enabled: true })),
  modFiles: new Map(Object.entries(filesByMod).map(([name, paths]) => [name, {
    origin: name, folder: `/mods/${name}`, folders: [], notes: [], files: paths.map((path) => fileIn(`/mods/${name}`, path)),
  }])),
});

const dataFolder = (...paths: string[]): DataFolderFiles =>
  ({ kind: 'listed', files: new Map(paths.map((relativePath) => [relativePath.toLowerCase(), { relativePath, path: `/game/Data/${relativePath}` }])) });

describe('the Papyrus scripts of the instance', () => {
  it.each<[string, Partial<InstanceReading>, PapyrusScript[]]>([
    ['each with the first source the Creation Kit reads that a mod holds, and its compiled script, by Data-relative path', modsHolding({
      Winning: ['Scripts/Ns/Quest.pex', 'Scripts/Source/Base/Ns/Quest.psc', 'Scripts/Compiled.pex'],
      Losing: ['Scripts/Source/User/Ns/Quest.psc', 'scripts/ns/quest.pex', 'Textures/Quest.pex'],
    }), [
      { name: 'Compiled', compiledDataPath: 'Scripts/Compiled.pex' },
      { name: 'Ns:Quest', sourceDataPath: 'Scripts/Source/User/Ns/Quest.psc', compiledDataPath: 'Scripts/Ns/Quest.pex' },
    ]],
    ['each with a source the Data folder holds', {
      ...modsHolding({ Mod: ['Scripts/Actor.pex'] }), dataFolderFiles: dataFolder('Scripts/Source/Base/Actor.psc', 'Scripts/Actor.pex'),
    }, [{ name: 'Actor', sourceDataPath: 'Scripts/Source/Base/Actor.psc', compiledDataPath: 'Scripts/Actor.pex' }]],
    ['none for a release the tables hold no script folders for', { ...modsHolding({ Mod: ['Scripts/Quest.pex'] }), gameRelease: 'Starfield' }, []],
  ])('are %s', async (_case, reading, scripts) => {
    const { instance } = loader(reading);

    await instance.refresh();

    expect(instance.value.papyrusScripts).toEqual(scripts);
  });
});
