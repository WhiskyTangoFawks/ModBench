import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVanillaMasters, discoverImplicitMasters } from './vanillaMasters';
import { buildTes4Buffer } from './test/buildTes4Buffer';

describe('readVanillaMasters', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('lists lowercased .esm and .esp basenames from the resolved Data folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-vanillamasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), '');
    await writeFile(join(dataFolder, 'DLCRobot.esm'), '');
    await writeFile(join(dataFolder, 'NotAMaster.esp'), '');

    const masters = await readVanillaMasters(dataFolder);
    expect(masters).toEqual(new Set(['fallout4.esm', 'dlcrobot.esm', 'notamaster.esp']));
  });

  it('includes .esl (Creation Club) and .esp plugins alongside .esm masters', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-vanillamasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), '');
    await writeFile(join(dataFolder, 'ccBGSFO4044-HellfirePowerArmor.esl'), '');
    await writeFile(join(dataFolder, 'Update.esp'), '');
    await writeFile(join(dataFolder, 'readme.txt'), '');

    const masters = await readVanillaMasters(dataFolder);
    expect(masters).toEqual(
      new Set(['fallout4.esm', 'ccbgsfo4044-hellfirepowerarmor.esl', 'update.esp']),
    );
  });

  it('returns an empty set (no fs access) when no Data folder was resolved', async () => {
    expect(await readVanillaMasters(undefined)).toEqual(new Set());
  });

  it('tolerates an unreachable Data folder and returns an empty set', async () => {
    expect(await readVanillaMasters('/no/such/game/path/Data')).toEqual(new Set());
  });

  it('logs the failure reason when falling back to an empty set', async () => {
    const logs: string[] = [];
    await readVanillaMasters('/no/such/game/path/Data', (m) => logs.push(m));
    expect(logs.length).toBeGreaterThan(0);
  });
});

// Discovers the game's implicitly-loaded masters (issue #108): a plugin file in
// the resolved Data folder that is NOT a hardlink (nlink === 1) is vanilla; a
// hardlinked file (nlink >= 2) is a deployed mod plugin, not vanilla. Ordering
// is derived via topological sort over each implicit master's own declared
// masters — never alphabetical, never a hardcoded per-game table.
describe('discoverImplicitMasters', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('returns [] (no fs call) when no Data folder was resolved', async () => {
    expect(await discoverImplicitMasters(undefined)).toEqual([]);
  });

  it('degrades to [] and logs when the Data folder is unreadable/missing', async () => {
    const logs: string[] = [];
    expect(await discoverImplicitMasters('/no/such/game/path/Data', (m) => logs.push(m))).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('a single vanilla file with no declared masters is discovered', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), buildTes4Buffer([]));

    expect(await discoverImplicitMasters(dataFolder)).toEqual(['Fallout4.esm']);
  });

  async function hardlinkFixture(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await mkdir(join(dir, 'mods', 'SomeMod'), { recursive: true });

    // Real (non-hardlinked) vanilla files — plain writeFile, nlink 1.
    await writeFile(join(dataFolder, 'Fallout4.esm'), buildTes4Buffer([]));
    await writeFile(join(dataFolder, 'DLCCoast.esm'), buildTes4Buffer(['Fallout4.esm']));

    // A deployed mod plugin — hardlinked from a mods/ source, nlink >= 2.
    const modSource = join(dir, 'mods', 'SomeMod', 'ModPlugin.esp');
    await writeFile(modSource, buildTes4Buffer([]));
    await link(modSource, join(dataFolder, 'ModPlugin.esp'));

    return dataFolder;
  }

  it('excludes hardlinked (deployed mod) plugins, includes non-hardlinked vanilla files', async () => {
    const dataFolder = await hardlinkFixture();
    const result = await discoverImplicitMasters(dataFolder);
    expect(result).not.toContain('ModPlugin.esp');
    expect(result).toEqual(expect.arrayContaining(['Fallout4.esm', 'DLCCoast.esm']));
    expect(result).toHaveLength(2);
  });

  it('orders implicit masters topologically by declared masters, not alphabetically', async () => {
    // Alphabetically "DLCCoast.esm" < "Fallout4.esm", which would be wrong —
    // DLCCoast.esm declares Fallout4.esm as its master, so Fallout4.esm must load first.
    const dataFolder = await hardlinkFixture();
    const result = await discoverImplicitMasters(dataFolder);
    expect(result).toEqual(['Fallout4.esm', 'DLCCoast.esm']);
  });

  it('a master-dependency cycle resolves without hanging or throwing, logging the fallback', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'A.esm'), buildTes4Buffer(['B.esm']));
    await writeFile(join(dataFolder, 'B.esm'), buildTes4Buffer(['A.esm']));

    const logs: string[] = [];
    const result = await discoverImplicitMasters(dataFolder, (m) => logs.push(m));
    expect(result).toEqual(expect.arrayContaining(['A.esm', 'B.esm']));
    expect(result).toHaveLength(2);
    expect(logs.some((l) => /cycle|fallback/i.test(l))).toBe(true);
  });

  it('a per-file readMasters failure degrades that one file (excluded, logged) without blanking the rest', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), buildTes4Buffer([]));
    // Corrupt header: not a valid TES4 signature — readMasters throws.
    await writeFile(join(dataFolder, 'Corrupt.esm'), Buffer.alloc(24));

    const logs: string[] = [];
    const result = await discoverImplicitMasters(dataFolder, (m) => logs.push(m));
    expect(result).toEqual(['Fallout4.esm']);
    expect(logs.some((l) => l.includes('Corrupt.esm'))).toBe(true);
  });
});
