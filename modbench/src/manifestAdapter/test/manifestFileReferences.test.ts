import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldTexts, NO_FILE_CHANGES, type RenamePlan } from '../../symbolNames/symbolNames';
import { pluginCompanionRule } from '../../tables/gamePaths';
import { BUILD_FILE } from '../../wire/sourceMod';
import { manifestNameOf, writeManifestIn } from '../manifestAdapter';
import { manifestFileReferences } from '../manifestFileReferences';

let root: string;
let folder: string;
let modFolder: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manifestFileReferences-'));
  folder = join(root, 'source', 'Mod A');
  modFolder = join(root, 'mods', 'Mod A');
  file = join(folder, BUILD_FILE);
  await mkdir(folder, { recursive: true });
  await mkdir(modFolder, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const TEXT = '{"version":1,"steps":[\n{"decompile":["A.esp","B.esp"]},\n{"copy":["a/A.esp","A.esp"]},\n{"unpack":{"In.7z":["A.esp"]}},\n{"pack":{"A - Main.ba2":["A.esp"]}}\n]}\n';
const NONE = heldTexts([]);
const PLUGIN = { name: 'a.ESP', origin: 'Mod A' };

const owner = () => manifestFileReferences({
  sourceFolders: () => new Map([['Mod A', folder]]),
  modFolderOf: (mod) => Promise.resolve(mod === 'Mod A' ? modFolder : undefined),
  companions: () => Promise.resolve(pluginCompanionRule('Fallout4')),
});
const at = (line: number, character: number) => ({ file, start: { line, character }, end: { line, character: character + 5 } });

describe('a build file names a plugin of its own mod in its steps (ADR-0028)', () => {
  it('answers each decompile, compile, copy and unpack step that names the plugin at the root, with its mod', async () => {
    await writeFile(file, TEXT);

    const { references, leftOut } = await owner().read({ name: 'A.esp', origin: 'Mod A' }, NONE);

    expect(leftOut).toEqual([]);
    expect(references).toEqual([at(1, 15), at(2, 20), at(3, 21)].map((place) => ({ place, names: { name: 'A.esp', origin: 'Mod A' } })));
  });

  it('reads the build file\'s unsaved text in place of the file', async () => {
    await writeFile(file, TEXT);

    const { references } = await owner().read({ name: 'B.esp', origin: 'Mod A' }, heldTexts([[file, '{"version":1,"steps":[{"compile":["B.esp"]}]}']]));

    expect(references).toEqual([{ place: { file, start: { line: 0, character: 35 }, end: { line: 0, character: 40 } }, names: { name: 'B.esp', origin: 'Mod A' } }]);
  });

  it('names nothing for a plugin of a mod that is no source mod, or whose folder holds no build file', async () => {
    expect((await owner().read({ name: 'A.esp', origin: 'Mod B' }, NONE)).references).toEqual([]);
    expect(await owner().read({ name: 'A.esp', origin: 'Mod A' }, NONE)).toEqual({ references: [], leftOut: [] });
  });

  it('leaves out a build file it cannot read, saying why', async () => {
    await writeFile(file, '{"version":2}');

    expect(await owner().read({ name: 'A.esp', origin: 'Mod A' }, NONE)).toEqual({
      references: [], leftOut: [`${file}: its build file is version 2, and Modbench reads only version 1`],
    });
  });
});

describe('the manifests and build files carry a rename of a plugin (formats/build-file.md, Canonical text)', () => {
  const RENAMED = '{"version":1,"steps":[\n{"decompile":["New.esp","B.esp"]},\n{"copy":["a/A.esp","New.esp"]},\n{"unpack":{"In.7z":["A.esp"]}},\n{"pack":{"New - Main.ba2":["New.esp"]}}\n]}\n';

  const planned = async (held = NONE): Promise<RenamePlan> => {
    const plan = await owner().plan(PLUGIN, 'New.esp', held, []);
    if ('refused' in plan) throw new Error(plan.refused);
    return plan;
  };

  it('changes only each name a step gives the plugin or a file named for it, and cannot carry one an unpack step takes out of its archive', async () => {
    await writeFile(file, TEXT);

    const plan = await planned();

    expect(plan.changes).toEqual({ ...NO_FILE_CHANGES, documents: [{ path: file, text: RENAMED }] });
    expect(plan.cannotFollow).toEqual([`${file}: its unpack step takes A.esp out of In.7z by that name.`]);
  });

  it('names each file of the source folder a step reads by a name the rename changes, once', async () => {
    await writeFile(file, '{"version":1,"steps":[{"decompile":["A.esp"]},{"copy":["A.esp","Strings/A_en.STRINGS"]},{"unpack":{"A - Main.ba2":["textures/a.dds"]}},{"compile":["A.esp"]}]}');

    expect(await owner().sourceFilesOf(PLUGIN, 'New.esp', NONE)).toEqual([
      { from: 'A.esp', to: 'New.esp' }, { from: 'Strings/A_en.STRINGS', to: 'Strings/New_en.STRINGS' }, { from: 'A - Main.ba2', to: 'New - Main.ba2' },
    ]);
  });

  it('changes the build file\'s unsaved text in place of the file', async () => {
    await writeFile(file, TEXT);

    const plan = await planned(heldTexts([[file, '{"version":1,"steps":[{"compile":["A.esp"]}]}']]));

    expect(plan.changes.documents).toEqual([{ path: file, text: '{"version":1,"steps":[{"compile":["New.esp"]}]}' }]);
  });

  it.each([['a mod that is no source mod', 'Mod B'], ['a source mod whose folder holds no build file', 'Mod A']])('changes nothing for a plugin of %s', async (_case, origin) => {
    expect(await owner().plan({ name: 'A.esp', origin }, 'New.esp', NONE, [])).toMatchObject({ changes: NO_FILE_CHANGES, cannotFollow: [] });
  });

  it('cannot carry a build file it cannot read, saying why', async () => {
    await writeFile(file, '{"version":2}');

    expect((await planned()).cannotFollow).toEqual([`${file}: its build file is version 2, and Modbench reads only version 1`]);
  });

  it('cannot carry the flags of the plugin\'s mod\'s manifest, which the user writes (manifest.md, Who writes it)', async () => {
    await writeManifestIn(modFolder, { packages: [], exclude: [], ignore: [], flags: new Map([['A.esp', { Small: true }]]), files: new Map([['A.esp', 'AAAAAAAAAAA=']]) });

    expect((await planned()).cannotFollow).toEqual([`${join(modFolder, manifestNameOf(modFolder))}: its flags name A.esp, which the user writes.`]);
  });
});

describe('the plugin a build file names at a place in its text', () => {
  it('is the name under the place in a step that names plugins at the root, with its mod', async () => {
    expect(await owner().nameAt(file, TEXT, TEXT.indexOf('B.esp') + 2)).toEqual({ name: 'B.esp', origin: 'Mod A' });
    expect(await owner().nameAt(file, TEXT, TEXT.indexOf('a/A.esp') + 3)).toBeUndefined();
    expect(await owner().nameAt(file, TEXT, TEXT.lastIndexOf('A.esp') + 1)).toBeUndefined();
  });

  it('is read in a build file the source folder spells in another case, and in no other file', async () => {
    expect(await owner().nameAt(join(folder, BUILD_FILE.toUpperCase()), TEXT, TEXT.indexOf('B.esp'))).toEqual({ name: 'B.esp', origin: 'Mod A' });
    expect(await owner().nameAt(join(root, 'Mod B', BUILD_FILE), TEXT, TEXT.indexOf('B.esp'))).toBeUndefined();
  });
});
