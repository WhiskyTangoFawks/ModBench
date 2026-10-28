import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

const busy = vi.hoisted(() => ({ links: [] as string[], unlinks: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const ebusy = (call: string, path: string) => Object.assign(new Error(`EBUSY: resource busy or locked, ${call} '${path}'`), { code: 'EBUSY' });
  return {
    ...actual,
    link: (from: string, to: string) => (busy.links.includes(to) ? Promise.reject(ebusy('link', to)) : actual.link(from, to)),
    unlink: (path: string) => (busy.unlinks.includes(path) ? Promise.reject(ebusy('unlink', path)) : actual.unlink(path)),
  };
});
import { hardlinkDeployment, type FileTheGameGets, type PluginOrder } from '../deployment';
import type { PluginsTxtPlace } from '../pluginsTxtPlace';
import { recordIn } from '../record';

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
  busy.links = [];
  busy.unlinks = [];
  place = () => ({ why: NOT_WRITTEN.why });
  order = { release: 'Fallout4', entries: [] };
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

const NOT_WRITTEN = { kind: 'notWritten', why: 'no place' } as const;
let place: PluginsTxtPlace;
let order: PluginOrder;

const deploy = (files: readonly FileTheGameGets[], to = folder) => hardlinkDeployment(storage, place).deploy(to, files, order);

const inode = async (path: string): Promise<bigint> => (await lstat(path, { bigint: true })).ino;

describe('deploy', () => {
  it.each([
    ['a file under the deployment folder\'s Data', 'meshes/armor.nif', 'Data/meshes/armor.nif'],
    ['a file in a mod\'s Root folder at the deployment folder\'s root', 'Root/f4se_loader.exe', 'f4se_loader.exe'],
    ['a file below a mod\'s Root folder at its path below the root', 'root/f4se/plugins/x.dll', 'f4se/plugins/x.dll'],
    ['a file named root at the mod\'s root under Data', 'root', 'Data/root'],
    ['a file in a source folder below the mod\'s root', 'scripts/source/x.psc', 'Data/scripts/source/x.psc'],
    ['a dot file below the mod\'s root', 'meshes/.DS_Store', 'Data/meshes/.DS_Store'],
  ])('writes %s, as a hardlink to its copy in the instance', async (_case, relativePath, deployedAt) => {
    const file = await modFile('Mod', relativePath);

    await deploy([file]);

    expect(await inode(join(folder, deployedAt))).toBe(await inode(file.winner));
  });

  it.each([
    ['dot file at the mod\'s root', '.gitignore'],
    ['file in a dot folder at the mod\'s root', '.git/config'],
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

    expect([deployed, [await changed(join(folder, 'Data', 'a.esp')), await changed(join(folder, 'b.dll'))]]).toEqual([{ wrote: false, leftOut: [], lost: [], leftAside: [], pluginsTxt: NOT_WRITTEN }, before]);
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
  it('is kept for each deployment folder apart', async () => {
    const other = join(root, 'other');
    await mkdir(other);
    await deploy([await modFile('Mod', 'a.esp')]);
    await deploy([await modFile('Mod', 'b.esp')], other);

    await deploy([]);

    expect(await readdir(folder, { recursive: true })).toEqual(['Data']);
  });

  it('is the same for the folder however the setting ends it', async () => {
    await deploy([await modFile('Mod', 'a.esp')], `${folder}${sep}`);

    await deploy([]);

    expect(await readdir(folder, { recursive: true })).toEqual(['Data']);
  });

  it.runIf(process.platform === 'win32')('(Windows matches a path without case) is the same for the folder in any case', async () => {
    await deploy([await modFile('Mod', 'a.esp')], folder.toUpperCase());

    await deploy([]);

    expect(await readdir(folder, { recursive: true })).toEqual(['Data']);
  });
});

const ASIDE = `b.esp.modbench_aside_${process.pid}_0`;

describe('a deploy that fails', () => {
  async function deployedOnce() {
    const lower = await modFile('Lower', 'a.esp');
    const removed = await modFile('Mod', 'b.esp');
    await deploy([lower, removed]);
    return { lower, removed, before: await listing() };
  }

  const listing = async () => (await readdir(folder, { recursive: true })).sort();

  const failingDeploy = async () => {
    busy.links.push(join(folder, 'Data', 'meshes', 'd.nif'));
    return deploy([await modFile('Upper', 'a.esp'), await modFile('Mod', 'textures/c.dds'), await modFile('Mod', 'meshes/d.nif')]);
  };

  it('leaves the deployment folder as it was, and names the file and the cause', async () => {
    const { lower, removed, before } = await deployedOnce();

    await expect(failingDeploy()).rejects.toThrow(`EBUSY: resource busy or locked, link '${join(folder, 'Data', 'meshes', 'd.nif')}'`);

    expect([await listing(), await inode(join(folder, 'Data', 'a.esp')), await inode(join(folder, 'Data', 'b.esp'))])
      .toEqual([before, await inode(lower.winner), await inode(removed.winner)]);
  });

  it('leaves what deploy wrote as it was', async () => {
    const { lower, removed } = await deployedOnce();
    await expect(failingDeploy()).rejects.toThrow();

    expect(await deploy([lower, removed])).toEqual({ wrote: false, leftOut: [], lost: [], leftAside: [], pluginsTxt: NOT_WRITTEN });
  });

  it('names each change it could not undo', async () => {
    await deployedOnce();
    busy.links.push(join(folder, 'Data', 'b.esp'));

    await expect(failingDeploy()).rejects.toThrow(
      `. Deploy could not undo: Data/b.esp, set aside as ${ASIDE} (EBUSY: resource busy or locked, link '${join(folder, 'Data', 'b.esp')}')`);
  });

  it('never replaces a file of the user\'s at the name it sets a file aside as', async () => {
    const { lower } = await deployedOnce();
    await writeFile(join(folder, 'Data', ASIDE), 'mine');

    await deploy([lower]);

    expect([await listing(), await readFile(join(folder, 'Data', ASIDE), 'utf8')]).toEqual([['Data', join('Data', 'a.esp'), join('Data', ASIDE)], 'mine']);
  });
});

describe('a deploy that lands', () => {
  const listing = async () => (await readdir(folder, { recursive: true })).sort();

  async function landedLeavingAside() {
    const kept = await modFile('Mod', 'a.esp');
    await deploy([kept, await modFile('Mod', 'b.esp')]);
    busy.unlinks.push(join(folder, 'Data', ASIDE));
    return { kept, deployed: await deploy([kept]) };
  }

  it('names each file it set aside and could not remove', async () => {
    const { deployed } = await landedLeavingAside();

    expect(deployed).toEqual({
      wrote: true, pluginsTxt: NOT_WRITTEN, leftOut: [], lost: [], leftAside: [`Data/${ASIDE} (EBUSY: resource busy or locked, unlink '${join(folder, 'Data', ASIDE)}')`],
    });
  });

  it('leaves one the next deploy removes', async () => {
    const { kept } = await landedLeavingAside();
    busy.unlinks = [];

    await deploy([kept]);

    expect(await listing()).toEqual(['Data', join('Data', 'a.esp')]);
  });
});

describe('a file a killed deploy set aside', () => {
  const KILLED = 'a.esp.modbench_aside_99999';
  const listing = async () => (await readdir(folder, { recursive: true })).sort();

  async function killedAfterSettingAside() {
    const file = await modFile('Mod', 'a.esp');
    await deploy([file]);
    await rename(join(folder, 'Data', 'a.esp'), join(folder, 'Data', KILLED));
    return file;
  }

  it.each([
    ['puts it back when the load order holds it', true, ['Data', join('Data', 'a.esp')]],
    ['removes it when the load order does not hold it', false, ['Data']],
  ])('%s', async (_case, held, after) => {
    const file = await killedAfterSettingAside();

    await deploy(held ? [file] : []);

    expect(await listing()).toEqual(after);
  });

  it('removes it when another file holds its path, which stays as it is', async () => {
    await killedAfterSettingAside();
    await writeFile(join(folder, 'Data', 'a.esp'), 'mine');

    const deployed = await deploy([await modFile('Mod', 'a.esp')]);

    expect([deployed.leftOut, await listing(), await readFile(join(folder, 'Data', 'a.esp'), 'utf8')])
      .toEqual([['Data/a.esp'], ['Data', join('Data', 'a.esp')], 'mine']);
  });

  it('is the user\'s when it is not the file deploy wrote', async () => {
    await deploy([await modFile('Mod', 'a.esp')]);
    await rm(join(folder, 'Data', 'a.esp'));
    await writeFile(join(folder, 'Data', KILLED), 'mine');

    await deploy([]);

    expect([await listing(), await readFile(join(folder, 'Data', KILLED), 'utf8')]).toEqual([['Data', join('Data', KILLED)], 'mine']);
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

describe('plugins.txt', () => {
  let game: string;
  let plugins: string;

  beforeEach(() => {
    game = join(root, 'local', 'Fallout4');
    plugins = join(game, 'plugins.txt');
    place = () => ({ folder: game });
    order = { release: 'Fallout4', entries: [{ name: 'A.esp', enabled: true }, { name: 'B.esp', enabled: false }] };
  });

  const siblings = async (): Promise<string[]> => (await readdir(game)).sort();

  it('is written where the game reads it, in the plugin order, with the folder made', async () => {
    const deployed = await deploy([await modFile('Mod', 'a.esp')]);

    expect([deployed.pluginsTxt, await readFile(plugins, 'utf8')]).toEqual([{ kind: 'written', renamed: [] }, '*A.esp\r\nB.esp\r\n']);
  });

  it('is asked for the release of the load order', async () => {
    const asked: (string | undefined)[] = [];
    place = (release) => {
      asked.push(release);
      return { folder: game };
    };

    await deploy([]);

    expect(asked).toEqual(['Fallout4']);
  });

  it('is renamed, not replaced, when deploy did not write it, and the report names the new name', async () => {
    await mkdir(game, { recursive: true });
    await writeFile(plugins, 'mine');

    const deployed = await deploy([]);

    expect([deployed.pluginsTxt, await siblings(), await readFile(`${plugins}.modbench_renamed`, 'utf8')])
      .toEqual([{ kind: 'written', renamed: [`${plugins}.modbench_renamed`] }, ['plugins.txt', 'plugins.txt.modbench_renamed'], 'mine']);
  });

  it('is renamed to a name that is free when an earlier rename holds the first', async () => {
    await mkdir(game, { recursive: true });
    await writeFile(plugins, 'first');
    await deploy([]);
    await rename(plugins, join(root, 'held'));
    await writeFile(plugins, 'second');

    const deployed = await deploy([]);

    expect([deployed.pluginsTxt, await readFile(`${plugins}.modbench_renamed`, 'utf8'), await readFile(`${plugins}.modbench_renamed_2`, 'utf8')])
      .toEqual([{ kind: 'written', renamed: [`${plugins}.modbench_renamed_2`] }, 'first', 'second']);
  });

  it('is replaced, with nothing renamed, when deploy wrote it and the order changed', async () => {
    await deploy([]);
    order = { release: 'Fallout4', entries: [{ name: 'B.esp', enabled: true }] };

    const deployed = await deploy([]);

    expect([deployed, await siblings(), await readFile(plugins, 'utf8')]).toEqual([
      { wrote: true, leftOut: [], lost: [], leftAside: [], pluginsTxt: { kind: 'written', renamed: [] } }, ['plugins.txt'], '*B.esp\r\n']);
  });

  it('is left alone when deploy wrote it and the order is the same', async () => {
    await deploy([]);
    const before = await inode(plugins);

    const deployed = await deploy([]);

    expect([deployed, await inode(plugins)]).toEqual([{ wrote: false, leftOut: [], lost: [], leftAside: [], pluginsTxt: { kind: 'unchanged', renamed: [] } }, before]);
  });

  it('is not written where the place gives no folder, and the files are', async () => {
    place = () => ({ why: 'no prefix' });

    const deployed = await deploy([await modFile('Mod', 'a.esp')]);

    expect([deployed.wrote, deployed.pluginsTxt, await readdir(join(folder, 'Data'))]).toEqual([true, { kind: 'notWritten', why: 'no prefix' }, ['a.esp']]);
  });

  it('is left as it was, with no folder made, when a file cannot be linked', async () => {
    const file = await modFile('Mod', 'a.esp');
    busy.links = [join(folder, 'Data', 'a.esp')];

    await expect(deploy([file])).rejects.toThrow('EBUSY');

    expect(await readdir(root)).not.toContain('local');
  });

  it('keeps the file deploy found, and writes no file, when plugins.txt cannot be renamed', async () => {
    const file = await modFile('Mod', 'a.esp');
    await mkdir(game, { recursive: true });
    await writeFile(plugins, 'mine');
    busy.links = [`${plugins}.modbench_renamed`];

    await expect(deploy([file])).rejects.toThrow('EBUSY');

    expect([await siblings(), await readFile(plugins, 'utf8'), await readdir(folder)]).toEqual([['plugins.txt'], 'mine', []]);
  });

  it('leaves the file it wrote as it was when a later deploy cannot link a file', async () => {
    await deploy([]);
    order = { release: 'Fallout4', entries: [{ name: 'C.esp', enabled: true }] };
    busy.links = [join(folder, 'Data', 'a.esp')];

    await expect(deploy([await modFile('Mod', 'a.esp')])).rejects.toThrow('EBUSY');

    expect([await siblings(), await readFile(plugins, 'utf8')]).toEqual([['plugins.txt'], '*A.esp\r\nB.esp\r\n']);
  });

  it('writes nothing and renames nothing when the file there already holds the text, whoever wrote it', async () => {
    await mkdir(game, { recursive: true });
    await writeFile(plugins, '*A.esp\r\nB.esp\r\n');
    const before = await inode(plugins);

    const deployed = await deploy([]);

    expect([deployed.pluginsTxt, deployed.wrote, await siblings(), await inode(plugins)]).toEqual([{ kind: 'unchanged', renamed: [] }, false, ['plugins.txt'], before]);
  });

  it('removes what a killed deploy left of its own, and renames nothing', async () => {
    await deploy([]);
    await writeFile(`${plugins}.modbench_new_77`, 'half');
    await writeFile(`${plugins}.modbench_aside_1_3`, 'stray');
    order = { release: 'Fallout4', entries: [{ name: 'C.esp', enabled: true }] };

    const deployed = await deploy([]);

    expect([deployed.pluginsTxt, await siblings()]).toEqual([{ kind: 'written', renamed: [] }, ['plugins.txt']]);
  });

  it('is its own when a killed deploy placed it and never recorded it, so it is replaced and nothing is renamed', async () => {
    await deploy([]);
    await link(plugins, `${plugins}.modbench_aside_1_1`);
    await rename(plugins, join(root, 'held'));
    await writeFile(plugins, '*Placed.esp\r\n');
    order = { release: 'Fallout4', entries: [{ name: 'C.esp', enabled: true }] };

    const deployed = await deploy([]);

    expect([deployed.pluginsTxt, await siblings(), await readFile(plugins, 'utf8')]).toEqual([{ kind: 'written', renamed: [] }, ['plugins.txt'], '*C.esp\r\n']);
  });

  it('is recorded as its own when a killed deploy placed it and it already holds the text', async () => {
    await deploy([]);
    await link(plugins, `${plugins}.modbench_aside_1_1`);
    await rename(plugins, join(root, 'held'));
    await writeFile(plugins, '*A.esp\r\nB.esp\r\n');
    await deploy([]);
    order = { release: 'Fallout4', entries: [{ name: 'C.esp', enabled: true }] };

    const deployed = await deploy([]);

    expect([deployed.pluginsTxt, await siblings()]).toEqual([{ kind: 'written', renamed: [] }, ['plugins.txt']]);
  });

  describe('with a renamed file the record does not name', () => {
    const orphan = (): string => `${plugins}.modbench_renamed`;
    const recordedRenamed = async (): Promise<readonly string[] | undefined> => (await recordIn(join(storage, 'deployment.json')).of(folder)).pluginsTxt?.renamed;

    it('names and records it, and writes nothing, when the file in place holds the text', async () => {
      await mkdir(game, { recursive: true });
      await writeFile(orphan(), 'mine');
      await writeFile(plugins, '*A.esp\r\nB.esp\r\n');

      const deployed = await deploy([]);

      expect([deployed.pluginsTxt, await siblings(), await recordedRenamed()]).toEqual([
        { kind: 'unchanged', renamed: [orphan()] }, ['plugins.txt', 'plugins.txt.modbench_renamed'], [orphan()]]);
    });

    it('names and records it, and renames the file in place as one deploy did not write, when the text differs', async () => {
      await mkdir(game, { recursive: true });
      await writeFile(orphan(), 'an earlier folder\'s');
      await writeFile(plugins, 'edited since');

      const deployed = await deploy([]);

      expect([deployed.pluginsTxt, await readFile(orphan(), 'utf8'), await readFile(`${orphan()}_2`, 'utf8'), await recordedRenamed()]).toEqual([
        { kind: 'written', renamed: [orphan(), `${orphan()}_2`] }, 'an earlier folder\'s', 'edited since', [orphan(), `${orphan()}_2`]]);
    });

    it('is replaced, nothing else renamed, when a file deploy set aside holds the recorded file ID', async () => {
      await deploy([]);
      await link(plugins, `${plugins}.modbench_aside_1_1`);
      await rename(plugins, join(root, 'held'));
      await writeFile(plugins, '*Placed.esp\r\n');
      await writeFile(orphan(), 'mine');
      order = { release: 'Fallout4', entries: [{ name: 'C.esp', enabled: true }] };

      const deployed = await deploy([]);

      expect([deployed.pluginsTxt, await siblings()]).toEqual([{ kind: 'written', renamed: [orphan()] }, ['plugins.txt', 'plugins.txt.modbench_renamed']]);
    });
  });

  it('records a name once when the user puts the file back and deploy renames it to the same name again', async () => {
    await mkdir(game, { recursive: true });
    await writeFile(plugins, 'mine');
    await deploy([]);
    await rename(plugins, join(root, 'held'));
    await rename(`${plugins}.modbench_renamed`, plugins);

    const deployed = await deploy([]);

    expect([deployed.pluginsTxt, (await recordIn(join(storage, 'deployment.json')).of(folder)).pluginsTxt?.renamed])
      .toEqual([{ kind: 'written', renamed: [`${plugins}.modbench_renamed`] }, [`${plugins}.modbench_renamed`]]);
  });

  it('keeps both names, each holding the user\'s file, when a deploy killed before it placed ours left a second link to it', async () => {
    await mkdir(game, { recursive: true });
    await writeFile(plugins, 'mine');
    await link(plugins, `${plugins}.modbench_renamed`);

    const deployed = await deploy([]);

    expect([deployed.pluginsTxt, await readFile(`${plugins}.modbench_renamed`, 'utf8'), await readFile(`${plugins}.modbench_renamed_2`, 'utf8')]).toEqual([
      { kind: 'written', renamed: [`${plugins}.modbench_renamed`, `${plugins}.modbench_renamed_2`] }, 'mine', 'mine']);
  });

  it('leaves the file deploy found, and no renamed file, when the record cannot be written', async () => {
    await mkdir(game, { recursive: true });
    await writeFile(plugins, 'mine');
    await mkdir(join(storage, 'deployment.json.tmp'), { recursive: true });

    await expect(deploy([])).rejects.toThrow();

    expect([await siblings(), await readFile(plugins, 'utf8')]).toEqual([['plugins.txt'], 'mine']);
  });

  it('is recorded with the name it renamed the file to, so purge can put it back', async () => {
    await mkdir(game, { recursive: true });
    await writeFile(plugins, 'mine');
    await deploy([]);
    order = { release: 'Fallout4', entries: [] };
    await deploy([]);

    const recorded = await recordIn(join(storage, 'deployment.json')).of(folder);

    expect(recorded.pluginsTxt).toEqual({ path: plugins, ino: String(await inode(plugins)), renamed: [`${plugins}.modbench_renamed`] });
  });
});
