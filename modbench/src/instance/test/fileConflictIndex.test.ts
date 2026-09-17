import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Mod, Separator, ModlistEntry } from '../instance';
import { buildFileConflictIndex, rootLevelWinners, foldPath } from '../fileConflictIndex';
import { parseModlist } from '../../mo2Codecs/modlistText';
import { computeModStatuses } from '../statusChecker';
import { deployToGameData, type DeployLink } from '../../mo2Files/files';
import { makeDeployerFixture } from '../../modmanager/test/deployerFixture';
import { present } from '../../ports/present';

// Passthrough by default, so one test can divert a path to a synthetic non-ENOENT error:
// chmod-based permission denial is silently bypassed when the runner is root.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const fixture = join(__dirname, '..', '..', 'modmanager', 'test', 'fixtures', 'conflict-instance');
const caseFixture = join(__dirname, '..', '..', 'modmanager', 'test', 'fixtures', 'case-conflict-instance');

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const separator = (name: string, enabled = true): Separator => ({ kind: 'separator', name, enabled });

describe('buildFileConflictIndex', () => {
  it('resolves the winner for an overridden file to the topmost (winning) mod', async () => {
    // modlist.txt is winning-first, so ModA — the array's first enabled mod — wins over ModB.
    const entries: ModlistEntry[] = [mod('ModA'), mod('ModB')];
    const index = await buildFileConflictIndex(entries, fixture, () => {});

    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.winnerMod).toBe('ModA');
    expect(entry?.winner).toBe(join(fixture, 'mods', 'ModA', 'textures', 'shared', 'foo.dds'));
    expect(entry?.providers.sort()).toEqual(['ModA', 'ModB']);
  });

  it('flips the winner when the mods are reordered', async () => {
    const index = await buildFileConflictIndex([mod('ModB'), mod('ModA')], fixture, () => {});
    expect(index.files.get('textures/shared/foo.dds')?.winnerMod).toBe('ModB');
  });

  it('excludes disabled mods entirely', async () => {
    const index = await buildFileConflictIndex([mod('ModA', false), mod('ModB')], fixture, () => {});
    const entry = index.files.get('textures/shared/foo.dds');
    expect(entry?.providers).toEqual(['ModB']);
    expect(entry?.winnerMod).toBe('ModB');
  });

  it('never treats meta.ini as a conflict, even though every mod has one', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture, () => {});
    expect(index.files.has('meta.ini')).toBe(false);
  });

  it('records a single-provider file with providers.length === 1', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture, () => {});
    const entry = index.files.get('meshes/onlyB.nif');
    expect(entry?.providers).toEqual(['ModB']);
    expect(entry?.winnerMod).toBe('ModB');
  });

  it('resolves nested subdirectory relative paths correctly', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture, () => {});
    // Iteration surface: entries carry their own original-cased relativePath,
    // not raw (possibly folded) Map keys.
    const paths = [...index.files].map((e) => e.relativePath);
    expect(paths).toContain('meshes/onlyB.nif');
    expect(paths).toContain('textures/shared/foo.dds');
  });

  it('groups each mod\'s own files under filesByMod', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], fixture, () => {});
    const modBFiles = index.filesByMod.get('ModB')?.map((f) => f.relativePath).sort();
    expect(modBFiles).toEqual(['meshes/onlyB.nif', 'textures/shared/foo.dds']);
  });

  it('excludes an enabled separator from the index — a separator is not a mod, even though it also carries `enabled`', async () => {
    const index = await buildFileConflictIndex([separator('Unassigned'), mod('ModA'), mod('ModB')], fixture, () => {});
    expect(index.filesByMod.has('Unassigned')).toBe(false);
    expect(index.files.get('textures/shared/foo.dds')?.winnerMod).toBe('ModA');
  });
});

// Proton/Wine folds case over case-sensitive ext4, so case-variant paths must resolve to one
// conflict entry with a deterministic winner.
describe('buildFileConflictIndex — case-insensitive conflicts', () => {
  it('resolves case-variant paths from two mods to a single conflict entry with both providers', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], caseFixture, () => {});

    expect(index.files.size).toBe(1);
    const entry = index.files.get('Textures/Foo.dds'); // look up via either casing
    expect(entry?.providers.sort()).toEqual(['ModA', 'ModB']);
    const entryOtherCasing = index.files.get('textures/foo.dds');
    expect(entryOtherCasing).toBe(entry);
  });

  it('picks the same winner by priority whether casing matches or varies', async () => {
    const top = await buildFileConflictIndex([mod('ModA'), mod('ModB')], caseFixture, () => {});
    expect(top.files.get('textures/foo.dds')?.winnerMod).toBe('ModA');

    const flipped = await buildFileConflictIndex([mod('ModB'), mod('ModA')], caseFixture, () => {});
    expect(flipped.files.get('textures/foo.dds')?.winnerMod).toBe('ModB');
  });

  it('keeps the winner\'s own original casing in relativePath and winner, regardless of lookup casing', async () => {
    const index = await buildFileConflictIndex([mod('ModA'), mod('ModB')], caseFixture, () => {});

    const entry = index.files.get('TEXTURES/FOO.DDS'); // deliberately different casing again
    expect(entry?.relativePath).toBe('Textures/Foo.dds'); // ModA's own casing (it won)
    expect(entry?.winner).toBe(join(caseFixture, 'mods', 'ModA', 'Textures', 'Foo.dds'));
  });

  it('rootLevelWinners folds a case-variant root-level plugin pair to one winner', async () => {
    const index = await buildFileConflictIndex([mod('RootA'), mod('RootB')], caseFixture, () => {});
    const winners = rootLevelWinners(index);

    expect(winners.size).toBe(1);
    expect(winners.get('foo.esp')).toBe(join(caseFixture, 'mods', 'RootA', 'Foo.esp'));
  });
});

// fs.symlink needs admin rights or Developer Mode on Windows and mkfifo doesn't exist there
// at all, so the whole block is skipped rather than failing for an environment reason.
describe.skipIf(process.platform === 'win32')('buildFileConflictIndex — non-regular dirent policy', () => {
  let instanceRoot: string;
  let modARoot: string;

  beforeEach(async () => {
    instanceRoot = await mkdtemp(join(tmpdir(), 'medit-conflict-nonregular-'));
    modARoot = join(instanceRoot, 'mods', 'ModA');
    await mkdir(modARoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(instanceRoot, { recursive: true, force: true });
  });

  it('a symlinked file participates in the index like a regular file', async () => {
    const targetDir = join(instanceRoot, 'shared');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'real.dds'), 'DATA');
    await symlink(join(targetDir, 'real.dds'), join(modARoot, 'linked.dds'));

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('linked.dds')).toBe(true);
    expect(index.filesByMod.get('ModA')?.map((f) => f.relativePath)).toEqual(['linked.dds']);
  });

  it('a symlinked directory is followed — files under it participate like a real subtree (the shared-asset-folder scenario)', async () => {
    const targetDir = join(instanceRoot, 'shared-textures');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'foo.dds'), 'DATA');
    await symlink(targetDir, join(modARoot, 'textures'));

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('textures/foo.dds')).toBe(true);
  });

  it('a broken symlink is skipped and logged, not thrown', async () => {
    await symlink(join(instanceRoot, 'does-not-exist.dds'), join(modARoot, 'broken.dds'));
    const log = vi.fn();

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, log);

    expect(index.files.has('broken.dds')).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('broken.dds'));
  });

  it('propagates a non-ENOENT stat error on a symlink target, rather than silently skipping it', async () => {
    await symlink(join(instanceRoot, 'whatever.dds'), join(modARoot, 'restricted.dds'));
    const { stat: actualStat } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(stat).mockImplementation(async (path, ...rest) => {
      if (String(path).endsWith('restricted.dds')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return actualStat(path, ...rest);
    });

    try {
      await expect(buildFileConflictIndex([mod('ModA')], instanceRoot, () => {})).rejects.toThrow(/EACCES|permission denied/);
    } finally {
      vi.mocked(stat).mockImplementation(actualStat);
    }
  });

  it('a symlink cycle is skipped and logged, not hung — and does not duplicate sibling content walked before the cycle is caught', async () => {
    // Real content alongside the self-referencing link pins the ancestor set's seed: a mod
    // containing only the loop cannot tell a seeded walk from an unseeded one.
    await writeFile(join(modARoot, 'sibling.dds'), 'DATA');
    await symlink(modARoot, join(modARoot, 'loop'));
    const log = vi.fn();

    // Red state before the cycle guard existed is unbounded recursion — bound it explicitly
    // rather than let a regression hang the whole suite.
    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, log);

    // Exactly once, at its real path — never also duplicated under loop/sibling.dds.
    expect([...index.files].map((e) => e.relativePath)).toEqual(['sibling.dds']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cycle'));
  }, 5000);

  it('a FIFO (and other non-regular, non-symlink entries) is excluded without error', async () => {
    execFileSync('mkfifo', [join(modARoot, 'pipe')]);
    const log = vi.fn();

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, log);

    expect(index.files.has('pipe')).toBe(false);
    expect(index.filesByMod.get('ModA')).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pipe'));
  });

  it('a symlink to a FIFO (or other non-regular target) is excluded without error, and the skip is logged', async () => {
    const fifoPath = join(instanceRoot, 'real-pipe');
    execFileSync('mkfifo', [fifoPath]);
    await symlink(fifoPath, join(modARoot, 'linked-pipe'));
    const log = vi.fn();

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, log);

    expect(index.files.has('linked-pipe')).toBe(false);
    expect(index.filesByMod.get('ModA')).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('linked-pipe'));
  });
});

// A root "source/" folder is excluded unconditionally, so neither it nor the dot-prefixed
// rule needs a sibling-plugin check and nothing can be left orphaned.
describe('buildFileConflictIndex — root "source/" and dot-prefixed exclusion', () => {
  let instanceRoot: string;
  let modARoot: string;

  beforeEach(async () => {
    instanceRoot = await mkdtemp(join(tmpdir(), 'medit-conflict-root-source-'));
    modARoot = join(instanceRoot, 'mods', 'ModA');
    await mkdir(modARoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(instanceRoot, { recursive: true, force: true });
  });

  it('excludes a .git directory at the mod root, at any depth beneath it', async () => {
    await writeFile(join(modARoot, 'Plugin.esp'), 'PLUGINBYTES');
    await mkdir(join(modARoot, '.git', 'objects', 'pack'), { recursive: true });
    await writeFile(join(modARoot, '.git', 'HEAD'), 'ref: refs/heads/main');
    await writeFile(join(modARoot, '.git', 'objects', 'pack', 'pack-abc.pack'), 'binary-ish');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect([...index.files].map((e) => e.relativePath)).toEqual(['Plugin.esp']);
    expect(index.filesByMod.get('ModA')?.map((f) => f.relativePath)).toEqual(['Plugin.esp']);
  });

  it('excludes any dot-prefixed file, not only directories', async () => {
    await writeFile(join(modARoot, 'Plugin.esp'), 'PLUGINBYTES');
    await writeFile(join(modARoot, '.gitignore'), '*\n');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('.gitignore')).toBe(false);
  });

  it('excludes a dot-prefixed directory nested below the mod root, not just at the root', async () => {
    await writeFile(join(modARoot, 'Plugin.esp'), 'PLUGINBYTES');
    await mkdir(join(modARoot, 'textures', '.thumbs'), { recursive: true });
    await writeFile(join(modARoot, 'textures', '.thumbs', 'cache.bin'), 'thumbnail cache');
    await writeFile(join(modARoot, 'textures', 'foo.dds'), 'texture bytes');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('textures/.thumbs/cache.bin')).toBe(false);
    expect(index.files.has('textures/foo.dds')).toBe(true);
  });

  it('excludes a root-level "source" directory, case-insensitively, with no sibling-plugin check needed', async () => {
    await writeFile(join(modARoot, 'Plugin.esp'), 'PLUGINBYTES');
    // An orphaned tree for a plugin that doesn't even exist in this mod — a sibling-plugin
    // guard would leave this deployable; the unconditional rule excludes the whole root folder.
    await mkdir(join(modARoot, 'source', 'DeletedPlugin.esp', 'npc_'), { recursive: true });
    await writeFile(join(modARoot, 'source', 'DeletedPlugin.esp', 'npc_', '000800.json'), '{}');
    await mkdir(join(modARoot, 'SOURCE'), { recursive: true }); // a second mod could ship any casing
    await writeFile(join(modARoot, 'SOURCE', 'stray.json'), '{}');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect([...index.files].map((e) => e.relativePath)).toEqual(['Plugin.esp']);
  });

  // Papyrus ships its own scripts nested under "Scripts/Source/…", never at the mod root, so a
  // nested directory of that name must still deploy.
  it('does NOT exclude a nested directory literally named "Source" — root-anchored, not any depth', async () => {
    await writeFile(join(modARoot, 'Plugin.esp'), 'PLUGINBYTES');
    await mkdir(join(modARoot, 'Scripts', 'Source'), { recursive: true });
    await writeFile(join(modARoot, 'Scripts', 'Source', 'MyScript.psc'), 'Scriptname MyScript');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('Scripts/Source/MyScript.psc')).toBe(true);
  });

  it('does NOT exclude an ordinary top-level file or folder that merely starts with "source"', async () => {
    await writeFile(join(modARoot, 'Plugin.esp'), 'PLUGINBYTES');
    await mkdir(join(modARoot, 'sourceish'), { recursive: true });
    await writeFile(join(modARoot, 'sourceish', 'note.txt'), 'ordinary content');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('sourceish/note.txt')).toBe(true);
  });
});

// Proves the override-order direction against a REAL MO2 instance, not synthetic fixtures.
// Opt-in: skipped when the instance is absent, via the MEDIT_LITR_INSTANCE override.
const litrInstance = process.env.MEDIT_LITR_INSTANCE ?? join(homedir(), 'Games', 'FO4', 'LitR');
const litrModlistPath = join(litrInstance, 'profiles', 'Life in the Ruins', 'modlist.txt');
const hasLitr = existsSync(litrModlistPath);


describe.skipIf(!hasLitr)('buildFileConflictIndex — real LitR instance (opt-in)', () => {
  // A real conflict in the live LitR modlist, not planted: a fix patch must override what it
  // fixes, which is an oracle independent of this codebase's own logic.
  const fixName = 'Pipboy Arm Fix for Grafs Assaultron Armor';
  const baseName = "Graf's Assaultron Armor";
  const contested = [
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavyf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavym.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumm.nif',
  ];

  // Badge and deploy consume the index's winner with no logic of their own, so asserting all
  // three proves they agree rather than documenting the rest away.
  it('a fix patch positioned above the mod it fixes wins the meshes they both ship — index, badge, and deploy all agree', async () => {
    const entries = parseModlist(readFileSync(litrModlistPath, 'utf8'));
    const fixEntry = entries.find((e) => e.kind === 'mod' && e.name === fixName);
    const baseEntry = entries.find((e) => e.kind === 'mod' && e.name === baseName);
    if (!fixEntry?.enabled || !baseEntry?.enabled) {
      throw new Error(
        `LitR fixture assumption broken: expected both "${fixName}" and "${baseName}" present and enabled in modlist.txt`,
      );
    }

    // 1. FileConflictIndex — the winner map itself.
    const index = await buildFileConflictIndex(entries, litrInstance, () => {});
    const winnerPaths = new Map<string, string>();
    for (const relativePath of contested) {
      const entry = index.files.get(relativePath);
      expect(entry?.providers.sort()).toEqual([baseName, fixName].sort());
      expect(entry?.winnerMod).toBe(fixName);
      winnerPaths.set(relativePath, present(entry, `the conflict index entry for "${relativePath}"`).winner);
    }

    // 2. Badge — statusChecker.ts's per-mod status, built from the SAME index, against the real
    // instance (read-only: modFolderExists stat calls, never a write).
    const statuses = await computeModStatuses([fixEntry, baseEntry], litrInstance, index);
    expect(statuses.get(fixName)?.status).toEqual({ kind: 'overrides', count: contested.length });
    // baseName's real count is 5: it also ships an .esl another enabled mod happens to ship,
    // a separate real collision that is part of its honest badge.
    expect(statuses.get(baseName)?.status).toEqual({ kind: 'conflicts', count: contested.length + 1 });
    for (const relativePath of contested) {
      // conflictLines carry the base mod's own on-disk casing, so compare through foldPath.
      expect(
        statuses
          .get(baseName)
          ?.conflictLines.some((line) => foldPath(line) === foldPath(`${relativePath} → winner: ${fixName}`)),
      ).toBe(true);
    }

    // Scratch temp dirs, so the live LitR instance is never written to; only the winner's
    // source path is real.
    const fx = await makeDeployerFixture();
    try {
      const links: DeployLink[] = [...winnerPaths].map(([relativePath, source]) => ({ relativePath, source }));
      await deployToGameData(fx.instanceRoot, fx.gameDirectory, links);
      for (const relativePath of contested) {
        const winner = present(winnerPaths.get(relativePath), `the winner source path for "${relativePath}"`);
        const target = join(fx.gameDirectory.dataFolder, relativePath);
        const [srcStat, tgtStat] = await Promise.all([stat(winner), stat(target)]);
        expect(tgtStat.ino).toBe(srcStat.ino); // same inode == a real hardlink to the winner, not a copy
        expect(tgtStat.dev).toBe(srcStat.dev);
      }
    } finally {
      await fx.cleanup();
    }
  });

  // This instance supplies no real vanilla-vs-mod loose-file pair: vanilla Data/ ships every
  // asset inside .ba2 archives and shares no root-level name with any enabled mod.
  it.todo('vanilla Data/ loose file loses to an enabled mod shipping the same file — no such real pair exists in this LitR instance; see deployer.test.ts for the synthetic-fixture proof of the invariant');
});
