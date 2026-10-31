import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestText, sourceModsOf, type Manifest, type ManifestPackage } from '../manifestAdapter';
import type { ModFolderAt } from '../sourceMods';

let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sourceMods-')); });
afterEach(() => rm(root, { recursive: true, force: true }));

const naming = (pkg: ManifestPackage): Manifest => ({ packages: [pkg], exclude: [], archives: [], files: [] });

const repository = (name: string): ManifestPackage => ({ kind: 'sourceRepository', name, isSubmodule: true });

async function modFolder(name: string, manifest?: Manifest): Promise<ModFolderAt> {
  const folder = join(root, 'mods', name);
  await mkdir(folder, { recursive: true });
  if (manifest !== undefined) await writeFile(join(folder, `${name}.manifest.json`), manifestText(manifest));
  return { kind: 'mod', modName: name, path: folder };
}

const source = (name: string): string => join(root, 'source', name);

const key = (mod: string): string => mod.toLowerCase();

describe('sourceModsOf', () => {
  it('links a mod to the repository its manifest names, whatever the repository is called', async () => {
    const mods = [await modFolder('Renamed Mod', naming(repository('Mod')))];

    const linked = await sourceModsOf(mods, new Map([['Mod', source('Mod')]]), key);

    expect([[...linked.folders], linked.folderOf('renamed mod'), linked.notes]).toEqual([[['Renamed Mod', source('Mod')]], source('Mod'), []]);
  });

  it('links no mod whose manifest names another package', async () => {
    const mods = [await modFolder('Mod', naming({ kind: 'installationFile', name: 'Mod.7z', size: 1, hash: 'H' }))];

    const linked = await sourceModsOf(mods, new Map(), key);

    expect([linked.folderOf('Mod'), linked.builds('Mod')]).toEqual([undefined, false]);
  });

  it('gives no folder to a mod whose repository the source folder does not hold, though the repository builds it', async () => {
    const mods = [await modFolder('Mod', naming(repository('Mod')))];

    const linked = await sourceModsOf(mods, new Map(), key);

    expect([linked.folderOf('Mod'), linked.builds('mod'), linked.notes]).toEqual([undefined, true, []]);
  });

  it('names a repository no manifest names after itself, so its first build makes the folder of its name', async () => {
    const linked = await sourceModsOf([], new Map([['New Mod', source('New Mod')]]), key);

    expect([...linked.folders]).toEqual([['New Mod', source('New Mod')]]);
  });

  it('links a repository no manifest names to the folder of its name that holds no manifest', async () => {
    const mods = [await modFolder('Mod')];

    const linked = await sourceModsOf(mods, new Map([['Mod', source('Mod')]]), key);

    expect(linked.folderOf('Mod')).toBe(source('Mod'));
  });

  it('leaves a repository no manifest names unlinked when the folder of its name holds another mod\'s manifest, and says so', async () => {
    const mods = [await modFolder('Mod', naming({ kind: 'installationFile', name: 'Mod.7z', size: 1, hash: 'H' }))];

    const linked = await sourceModsOf(mods, new Map([['Mod', source('Mod')]]), key);

    expect([linked.folderOf('Mod'), linked.notes]).toEqual([
      undefined, [`${source('Mod')} is not a source mod: no manifest names it, and the folder of the mod 'Mod' is another mod's.`],
    ]);
  });

  it('says a folder whose manifest cannot be read builds from no repository, and links the repository of its name to nothing', async () => {
    const mod = await modFolder('Mod');
    await writeFile(join(mod.path, 'Mod.manifest.json'), '{');

    const linked = await sourceModsOf([mod], new Map([['Mod', source('Mod')]]), key);

    expect([linked.folderOf('Mod'), linked.notes]).toEqual([undefined, [`${mod.path} builds from no repository, as its manifest cannot be read at line 1.`]]);
  });

  it('says a folder that cannot be read builds from no repository', async () => {
    const folder = join(root, 'mods', 'Mod');
    await mkdir(join(root, 'mods'), { recursive: true });
    await writeFile(folder, 'a file where the folder is');

    const linked = await sourceModsOf([{ kind: 'mod', modName: 'Mod', path: folder }], new Map(), key);

    expect(linked.notes.map((note) => note.startsWith(`${folder} builds from no repository, as its manifest could not be read: `))).toEqual([true]);
  });

  it('does not name a repository after itself once a manifest names it', async () => {
    const mods = [await modFolder('Renamed Mod', naming(repository('Mod')))];

    const linked = await sourceModsOf(mods, new Map([['Mod', source('Mod')]]), key);

    expect(linked.folderOf('Mod')).toBeUndefined();
  });
});
