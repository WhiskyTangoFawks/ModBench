import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, link, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVanillaMasters, discoverImplicitMasters } from './vanillaMasters';
import { buildTes4Buffer } from './test/buildTes4Buffer';

// Scoped to this file only, passthrough by default: wraps `readdir` so one test
// below can force a specific discovery order deterministically (POSIX doesn't
// guarantee readdir order, and this repo's own tests elsewhere rely on the
// topological sort being correct *regardless* of it — so ordering-sensitive
// assertions must force the order rather than assume it).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

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

    const masters = await readVanillaMasters(dataFolder, () => {});
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

    const masters = await readVanillaMasters(dataFolder, () => {});
    expect(masters).toEqual(
      new Set(['fallout4.esm', 'ccbgsfo4044-hellfirepowerarmor.esl', 'update.esp']),
    );
  });

  it('returns an empty set with no log call (no fs access) when no Data folder was resolved', async () => {
    const log = vi.fn();
    expect(await readVanillaMasters(undefined, log)).toEqual(new Set());
    expect(log).not.toHaveBeenCalled();
  });

  it('tolerates an unreachable Data folder and returns an empty set', async () => {
    expect(await readVanillaMasters('/no/such/game/path/Data', () => {})).toEqual(new Set());
  });

  it('logs the failure reason when falling back to an empty set', async () => {
    const logs: string[] = [];
    await readVanillaMasters('/no/such/game/path/Data', (m) => logs.push(m));
    expect(logs.some((l) => l.includes('[vanillaMasters]') && l.includes('could not resolve vanilla masters'))).toBe(
      true,
    );
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

  it('returns [] with no log call (no fs call) when no Data folder was resolved', async () => {
    const log = vi.fn();
    expect(await discoverImplicitMasters(undefined, log)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('degrades to [] and logs when the Data folder is unreadable/missing', async () => {
    const logs: string[] = [];
    expect(await discoverImplicitMasters('/no/such/game/path/Data', (m) => logs.push(m))).toEqual([]);
    expect(
      logs.some((l) => l.includes('[vanillaMasters]') && l.includes('could not resolve implicit masters')),
    ).toBe(true);
  });

  it('a single vanilla file with no declared masters is discovered', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), buildTes4Buffer([]));

    expect(await discoverImplicitMasters(dataFolder, () => {})).toEqual(['Fallout4.esm']);
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
    const result = await discoverImplicitMasters(dataFolder, () => {});
    expect(result).not.toContain('ModPlugin.esp');
    expect(result).toEqual(expect.arrayContaining(['Fallout4.esm', 'DLCCoast.esm']));
    expect(result).toHaveLength(2);
  });

  it('orders implicit masters topologically by declared masters, not alphabetically', async () => {
    // Alphabetically "DLCCoast.esm" < "Fallout4.esm", which would be wrong —
    // DLCCoast.esm declares Fallout4.esm as its master, so Fallout4.esm must load first.
    const dataFolder = await hardlinkFixture();
    const result = await discoverImplicitMasters(dataFolder, () => {});
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

  it('a dangling symlink degrades that one file (excluded, logged) without blanking the rest', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), buildTes4Buffer([]));
    // readdir() lists a broken symlink; stat() (which follows links) throws
    // ENOENT on its missing target — deterministic, no chmod/root flakiness
    // (#317's lesson: chmod-based permission denial is bypassed as root).
    await symlink(join(dataFolder, 'DoesNotExist.esm'), join(dataFolder, 'Broken.esm'));

    const logs: string[] = [];
    const result = await discoverImplicitMasters(dataFolder, (m) => logs.push(m));
    expect(result).toEqual(['Fallout4.esm']);
    expect(logs.some((l) => l.includes('[vanillaMasters]') && l.includes('Broken.esm'))).toBe(true);
  });

  it('excludes non-plugin files from candidates (e.g. a texture archive alongside .esm files)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), buildTes4Buffer([]));
    // A real Data folder ships non-plugin files alongside masters (BA2 archives).
    await writeFile(join(dataFolder, 'Fallout4 - Textures1.ba2'), 'not a plugin');

    const logs: string[] = [];
    const result = await discoverImplicitMasters(dataFolder, (m) => logs.push(m));
    expect(result).toEqual(['Fallout4.esm']);
    // If the extension filter were skipped, the .ba2 would reach readMasters,
    // fail its TES4 check, and get logged — it must never be attempted at all.
    expect(logs.some((l) => l.includes('Textures1.ba2'))).toBe(false);
  });

  it('returns [] with no log calls when every candidate in Data is a hardlinked (mod-deployed) plugin', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await mkdir(join(dir, 'mods', 'SomeMod'), { recursive: true });
    const modSource = join(dir, 'mods', 'SomeMod', 'ModPlugin.esp');
    await writeFile(modSource, buildTes4Buffer([]));
    await link(modSource, join(dataFolder, 'ModPlugin.esp'));

    const logs: string[] = [];
    expect(await discoverImplicitMasters(dataFolder, (m) => logs.push(m))).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('ignores an edge to a name outside the discovered set (e.g. a partial DLC install)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    // DLCNukaWorld.esm masters DLCRobot.esm, but DLCRobot.esm isn't present in
    // this Data folder — a real, if broken, partial-DLC install.
    await writeFile(join(dataFolder, 'DLCNukaWorld.esm'), buildTes4Buffer(['DLCRobot.esm']));

    const result = await discoverImplicitMasters(dataFolder, () => {});
    expect(result).toEqual(['DLCNukaWorld.esm']);
  });

  it('visits every declared master, not just the first, when a node has multiple dependencies', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-implicitmasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    // Real DLCs commonly master 2+ files (e.g. DLCNukaWorld.esm masters both
    // Fallout4.esm and DLCRobot.esm).
    await writeFile(join(dataFolder, 'AAAMaster.esm'), buildTes4Buffer(['ZZZDep1.esm', 'ZZZDep2.esm']));
    await writeFile(join(dataFolder, 'ZZZDep1.esm'), buildTes4Buffer([]));
    await writeFile(join(dataFolder, 'ZZZDep2.esm'), buildTes4Buffer([]));

    // Force AAAMaster.esm to be discovered before either of its own two
    // dependencies — POSIX doesn't guarantee readdir order, so this isolates
    // "visits every dep, not just the first" from filesystem ordering.
    // discoverImplicitMasters always calls `readdir(dataFolder)` with no
    // options, so the mock only needs to honor that one call shape.
    const { readdir: actualReaddir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readdir).mockImplementation((async (path: string) => {
      const names = await actualReaddir(path);
      return [...names].sort((a, b) => (a === 'AAAMaster.esm' ? -1 : b === 'AAAMaster.esm' ? 1 : 0));
    }) as typeof readdir);

    try {
      const result = await discoverImplicitMasters(dataFolder, () => {});
      expect(result.indexOf('ZZZDep1.esm')).toBeLessThan(result.indexOf('AAAMaster.esm'));
      expect(result.indexOf('ZZZDep2.esm')).toBeLessThan(result.indexOf('AAAMaster.esm'));
    } finally {
      vi.mocked(readdir).mockImplementation(actualReaddir);
    }
  });
});
