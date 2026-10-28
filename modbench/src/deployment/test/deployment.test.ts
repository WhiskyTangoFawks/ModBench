import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hardlinkDeployment, type FileTheGameGets } from '../deployment';

let root: string;
let mods: string;
let folder: string;
let storage: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deployment-'));
  mods = join(root, 'mods');
  folder = join(root, 'deployed');
  storage = join(root, 'storage');
  await mkdir(folder);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function modFile(mod: string, relativePath: string, content = relativePath): Promise<FileTheGameGets> {
  const winner = join(mods, mod, relativePath);
  await mkdir(dirname(winner), { recursive: true });
  await writeFile(winner, content);
  return { relativePath, winner };
}

const deploy = (files: readonly FileTheGameGets[], to = folder) => hardlinkDeployment(storage).deploy(to, files);

const inode = async (path: string): Promise<bigint> => (await lstat(path, { bigint: true })).ino;

describe('deploy', () => {
  it.each([
    ['a file under the deployment folder\'s Data', 'meshes/armor.nif', 'Data/meshes/armor.nif'],
    ['a file in a mod\'s Root folder at the deployment folder\'s root', 'Root/f4se_loader.exe', 'f4se_loader.exe'],
    ['a file below a mod\'s Root folder at its path below the root', 'root/f4se/plugins/x.dll', 'f4se/plugins/x.dll'],
    ['a file named root at the mod\'s root under Data', 'root', 'Data/root'],
    ['a file in a source folder below the mod\'s root', 'scripts/source/x.psc', 'Data/scripts/source/x.psc'],
  ])('writes %s, as a hardlink to its copy in the instance', async (_case, relativePath, deployedAt) => {
    const file = await modFile('Mod', relativePath);

    await deploy([file]);

    expect(await inode(join(folder, deployedAt))).toBe(await inode(file.winner));
  });

  it.each([
    ['dot file', '.gitignore'],
    ['file in a dot folder', '.git/config'],
    ['dot file below the mod\'s root', 'meshes/.DS_Store'],
    ['file in a source folder at the mod\'s root', 'source/scripts/x.psc'],
    ['file in a Source folder at the mod\'s root', 'Source/x.psc'],
  ])('writes no %s', async (_case, relativePath) => {
    await deploy([await modFile('Mod', relativePath)]);

    expect(await readdir(folder, { recursive: true })).toEqual([]);
  });
});

describe('two files the game gets that land at one path', () => {
  it.each([
    ['a mod\'s file over a Root folder\'s', 'x.ini', 'Root/Data/x.ini'],
    ['a Root folder\'s file over a mod\'s', 'Root/Data/x.ini', 'X.ini'],
  ])('deploys the one the load order gives first, %s, and names the other with the path it lost', async (_case, winning, losing) => {
    const winner = await modFile('Upper', winning);
    const loser = await modFile('Lower', losing);

    const deployed = await deploy([winner, loser]);

    expect([await inode(join(folder, 'Data', 'x.ini')), deployed.lost]).toEqual([await inode(winner.winner), [{ path: 'Data/x.ini', winner: loser.winner }]]);
  });
});

describe('a deploy after another', () => {
  const changed = async (path: string): Promise<bigint> => (await lstat(path, { bigint: true })).ctimeNs;

  it('writes nothing when the load order is the one it deployed', async () => {
    const files = [await modFile('Mod', 'a.esp'), await modFile('Mod', 'Root/b.dll')];
    await deploy(files);
    const before = [await changed(join(folder, 'Data', 'a.esp')), await changed(join(folder, 'b.dll'))];

    const deployed = await deploy(files);

    expect([deployed, [await changed(join(folder, 'Data', 'a.esp')), await changed(join(folder, 'b.dll'))]]).toEqual([{ wrote: false, leftOut: [], lost: [] }, before]);
  });

  it('removes a file it wrote that the load order does not hold', async () => {
    const kept = await modFile('Mod', 'a.esp');
    await deploy([kept, await modFile('Mod', 'b.esp')]);

    await deploy([kept]);

    expect(await readdir(join(folder, 'Data'))).toEqual(['a.esp']);
  });

  it('links again a file whose winner changed', async () => {
    await deploy([await modFile('Lower', 'a.esp')]);
    const winner = await modFile('Upper', 'a.esp');

    await deploy([winner]);

    expect(await inode(join(folder, 'Data', 'a.esp'))).toBe(await inode(winner.winner));
  });

  it('keeps the casing of a path it wrote, so a winner whose casing changed writes nothing', async () => {
    await deploy([await modFile('Mod', 'Meshes/A.nif')]);

    const deployed = await deploy([{ relativePath: 'meshes/a.nif', winner: join(mods, 'Mod', 'Meshes', 'A.nif') }]);

    expect([deployed.wrote, await readdir(join(folder, 'Data'), { recursive: true })]).toEqual([false, ['Meshes', join('Meshes', 'A.nif')]]);
  });
});

describe('the casing deploy writes a path in', () => {
  it('is the casing of the folder the deployment folder holds', async () => {
    await mkdir(join(folder, 'Data', 'Meshes'), { recursive: true });

    await deploy([await modFile('Mod', 'meshes/a.nif')]);

    expect(await readdir(join(folder, 'Data'))).toEqual(['Meshes']);
  });

  it('is the casing of the folder deploy wrote first, for each file below it', async () => {
    await deploy([await modFile('Mod', 'Textures/a.dds'), await modFile('Other', 'textures/b.dds')]);

    expect(await readdir(join(folder, 'Data'), { recursive: true })).toEqual(['Textures', join('Textures', 'a.dds'), join('Textures', 'b.dds')]);
  });
});

describe('a file in the deployment folder that deploy did not write', () => {
  const contentOf = (path: string): Promise<string> => readFile(path, 'utf8');

  async function replaced(path: string, content: string): Promise<void> {
    await rm(path);
    await writeFile(path, content);
  }

  it('is left, and its path named, when the load order holds a file at its path', async () => {
    await mkdir(join(folder, 'Data'));
    await writeFile(join(folder, 'Data', 'a.esp'), 'mine');

    const deployed = await deploy([await modFile('Mod', 'a.esp')]);

    expect([deployed.leftOut, await contentOf(join(folder, 'Data', 'a.esp'))]).toEqual([['Data/a.esp'], 'mine']);
  });

  it.each([
    ['its winner changed', 'Upper'],
    ['its winner is the same', 'Lower'],
  ])('is left, and its path named, when another program replaced a file deploy wrote and %s', async (_case, winningMod) => {
    await deploy([await modFile('Lower', 'MCM/settings.ini')]);
    await replaced(join(folder, 'Data', 'MCM', 'settings.ini'), 'mine');

    const deployed = await deploy([await modFile(winningMod, 'MCM/settings.ini')]);

    expect([deployed.leftOut, await contentOf(join(folder, 'Data', 'MCM', 'settings.ini'))]).toEqual([['Data/MCM/settings.ini'], 'mine']);
  });

  it('is left when another program replaced a file deploy wrote and the load order does not hold it', async () => {
    await deploy([await modFile('Mod', 'MCM/settings.ini')]);
    await replaced(join(folder, 'Data', 'MCM', 'settings.ini'), 'mine');

    await deploy([]);

    expect(await contentOf(join(folder, 'Data', 'MCM', 'settings.ini'))).toBe('mine');
  });
});

describe('what deploy wrote', () => {
  it('is deploy\'s still when a deploy is cut short', async () => {
    const linked = await modFile('Mod', 'a.esp');
    const unlinkable = { relativePath: 'b.esp', winner: join(mods, 'Mod') };
    await expect(deploy([linked, unlinkable])).rejects.toThrow();

    await deploy([]);

    expect(await readdir(folder, { recursive: true })).toEqual(['Data']);
  });

  it('is kept for each deployment folder apart', async () => {
    const other = join(root, 'other');
    await mkdir(other);
    await deploy([await modFile('Mod', 'a.esp')]);
    await deploy([await modFile('Mod', 'b.esp')], other);

    await deploy([]);

    expect(await readdir(folder, { recursive: true })).toEqual(['Data']);
  });
});

describe('a deploy refused', () => {
  it('names the deployment folder that does not exist', async () => {
    const missing = join(root, 'missing');

    await expect(deploy([await modFile('Mod', 'a.esp')], missing)).rejects.toThrow(`The deployment folder ${missing} does not exist.`);
  });

  it.runIf(process.platform === 'linux')('(a tmpfs is a volume of its own on Linux) names both volumes, and writes nothing', async () => {
    const elsewhere = await mkdtemp(join('/dev/shm', 'deployment-'));
    try {
      await expect(deploy([await modFile('Mod', 'a.esp')], elsewhere)).rejects.toThrow(
        /^The deployment folder is on \/dev\/shm, and the instance on \/\S*: a hardlink cannot cross volumes\.$/);
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
