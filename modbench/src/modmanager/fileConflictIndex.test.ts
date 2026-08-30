import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Mod, Separator, ModlistEntry } from './model';
import { buildFileConflictIndex, rootLevelWinners, foldPath } from './fileConflictIndex';
import { parseModlist } from './mo2/modlistText';
import { computeModStatuses } from './statusChecker';
import { readVanillaMasters } from './vanillaMasters';
import { deploy } from './deployer';
import { makeDeployerFixture, makeIndex } from './test/deployerFixture';

// Scoped to this file only, passthrough by default: wraps `stat` so a single test below can
// divert one specific path to a synthetic non-ENOENT error. Same wrapper shape as
// statusChecker.test.ts's #318 mock — chmod-based permission denial is silently bypassed
// when the test runner is root, which a real fs precondition isn't.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const fixture = join(__dirname, 'test', 'fixtures', 'conflict-instance');
const caseFixture = join(__dirname, 'test', 'fixtures', 'case-conflict-instance');

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const separator = (name: string, enabled = true): Separator => ({ kind: 'separator', name, enabled });

describe('buildFileConflictIndex', () => {
  it('resolves the winner for an overridden file to the topmost (winning) mod', async () => {
    // Entries are in modlist.txt file order, top-first. Top of the file is the
    // winning end (MO2: vanilla/base is losing-most, everything above overrides
    // it), so ModA — the array's first enabled mod — wins over ModB. Both provide
    // textures/shared/foo.dds. Getting the direction wrong would make ModB win.
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

// Proton/Wine resolves paths case-insensitively over ext4's case-sensitive
// mods/, so two mods providing case-variant paths (Textures/Foo.dds vs
// textures/foo.dds) must resolve to ONE conflict entry with a deterministic
// winner (#128). caseFixture: ModA/Textures/Foo.dds vs ModB/textures/foo.dds;
// RootA/Foo.esp vs RootB/foo.ESP (root-level, for rootLevelWinners).
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

// Non-regular dirent policy (#322): what MO2 itself does with such entries
// (references/modorganizer/ — grep-only, see fileConflictIndex.ts's walk() doc comment)
// is the precedent — follow a symlink transparently, surface what fails, guard the cycle
// Windows' own reparse-hop ceiling would otherwise hide. fs.symlink needs admin rights or
// Developer Mode on Windows, and mkfifo doesn't exist there at all (#185 plans a Windows CI
// leg) — skip the whole block there rather than fail for an environment reason that isn't a
// code defect. Linux coverage, including mutation, is unaffected.
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

  it('propagates a non-ENOENT stat error on a symlink target, rather than silently skipping it (#322 / #318 convention)', async () => {
    await symlink(join(instanceRoot, 'whatever.dds'), join(modARoot, 'restricted.dds'));
    const { stat: actualStat } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(stat).mockImplementation(async (path, ...rest) => {
      if (String(path).endsWith('restricted.dds')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return actualStat(path, ...(rest as []));
    });

    try {
      await expect(buildFileConflictIndex([mod('ModA')], instanceRoot, () => {})).rejects.toThrow(/EACCES|permission denied/);
    } finally {
      vi.mocked(stat).mockImplementation(actualStat);
    }
  });

  it('a symlink cycle is skipped and logged, not hung — and does not duplicate sibling content walked before the cycle is caught', async () => {
    // Real content alongside the self-referencing link: this is what pins the ancestor
    // set's seed (the mod root itself). An unseeded walk still terminates — it just catches
    // the cycle one hop later, after re-walking (and re-indexing) everything through
    // `loop/` once more — so a mod containing *only* the loop can't tell the two apart; both
    // produce the same empty result.
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

// #374: MEditService's per-plugin source text tree lands inside the mod folder itself
// (`<pluginFileName>.source/...`, the pre-#441 layout — #540 deletes it) and must not deploy or appear as mod content.
// Three-outcome
// shape mirrors the #324 hazard-class pattern: the real thing is excluded, a look-alike with no
// sibling plugin is not (over-match guard), and a plain file sharing the name is not
// (directory-only guard).
describe('buildFileConflictIndex — source text tree exclusion (#374)', () => {
  let instanceRoot: string;
  let modARoot: string;

  beforeEach(async () => {
    instanceRoot = await mkdtemp(join(tmpdir(), 'medit-conflict-source-'));
    modARoot = join(instanceRoot, 'mods', 'ModA');
    await mkdir(modARoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(instanceRoot, { recursive: true, force: true });
  });

  // Plugin base name is deliberately NOT 7 characters (mutation review, #374): ".source" is also
  // 7 characters, so a fixture named e.g. "Foo.esp" makes `slice(0, -SOURCE_TREE_SUFFIX.length)`
  // (strip the last 7 chars) and a mutated `slice(0, SOURCE_TREE_SUFFIX.length)` (keep the first
  // 7 chars) produce the identical string by coincidence, hiding a real off-by-construction bug.
  // "MyMod.esp" (9 chars) makes the two diverge. Every exclusion-asserting test below uses it for
  // that reason — the tests that assert something stays *visible* aren't sensitive to this
  // (nothing distinguishes front-slice from back-slice when no exclusion is expected either way).
  const PLUGIN = 'MyMod.esp';

  it('excludes the source text tree of a plugin actually present in the mod', async () => {
    await writeFile(join(modARoot, PLUGIN), 'PLUGINBYTES');
    const sourceRecordDir = join(modARoot, `${PLUGIN}.source`, 'records', PLUGIN);
    await mkdir(sourceRecordDir, { recursive: true });
    await writeFile(join(sourceRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has(PLUGIN)).toBe(true);
    expect([...index.files].map((e) => e.relativePath)).toEqual([PLUGIN]);
    expect(index.filesByMod.get('ModA')?.map((f) => f.relativePath)).toEqual([PLUGIN]);
  });

  it('matches the sibling plugin case-insensitively (Bethesda plugin casing is inconsistent)', async () => {
    const upper = PLUGIN.toUpperCase();
    await writeFile(join(modARoot, upper), 'PLUGINBYTES');
    const sourceRecordDir = join(modARoot, `${PLUGIN}.source`, 'records', PLUGIN);
    await mkdir(sourceRecordDir, { recursive: true });
    await writeFile(join(sourceRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect([...index.files].map((e) => e.relativePath)).toEqual([upper]);
  });

  // Same shape as the existing #322 symlinked-file test above ("a symlinked file participates in
  // the index like a regular file"): this walker treats a symlinked plugin as equivalent to a
  // real one everywhere else, so the sibling check must too, or an MO2-style symlinked-plugin mod
  // would acquire a source tree the exclusion never recognizes and it would deploy straight into
  // Data/ (review finding, #374).
  it('excludes the source text tree when the sibling plugin is a symlink, mirroring the #322 walk policy', async () => {
    const targetDir = join(instanceRoot, 'shared');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'real.esp'), 'PLUGINBYTES');
    await symlink(join(targetDir, 'real.esp'), join(modARoot, PLUGIN));
    const sourceRecordDir = join(modARoot, `${PLUGIN}.source`, 'records', PLUGIN);
    await mkdir(sourceRecordDir, { recursive: true });
    await writeFile(join(sourceRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect([...index.files].map((e) => e.relativePath)).toEqual([PLUGIN]);
  });

  it('also excludes the source text tree when the sibling plugin symlink is dangling — accepted, not guarded against', async () => {
    await symlink(join(instanceRoot, 'does-not-exist.esp'), join(modARoot, PLUGIN));
    const sourceRecordDir = join(modARoot, `${PLUGIN}.source`, 'records', PLUGIN);
    await mkdir(sourceRecordDir, { recursive: true });
    await writeFile(join(sourceRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    // The dangling link itself is skipped by the walker's own broken-symlink policy (#322) — the
    // source tree exclusion is what's under test, and it must not surface despite that.
    expect(index.files.has(`${PLUGIN}.source/records/${PLUGIN}/00001E.yaml`)).toBe(false);
  });

  // Mutation review (#374): nothing constrained the sibling check to files/symlinks specifically
  // — a directory sharing the plugin's exact name must NOT count as "the plugin", or a mod
  // shipping both a folder and a same-named-plus-".source" folder would have real content swept
  // away as if it were source state.
  it('does not treat a directory sharing the plugin\'s name as a valid sibling — only a file or symlink counts', async () => {
    await mkdir(join(modARoot, PLUGIN), { recursive: true }); // a directory, not the plugin file
    const sourceRecordDir = join(modARoot, `${PLUGIN}.source`, 'records', PLUGIN);
    await mkdir(sourceRecordDir, { recursive: true });
    await writeFile(join(sourceRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has(`${PLUGIN}.source/records/${PLUGIN}/00001E.yaml`)).toBe(true);
  });

  it('does NOT exclude a "*.source" folder with no matching plugin file — an author-named folder is ordinary content (#324 over-match guard)', async () => {
    const lookalikeDir = join(modARoot, 'Bar.source');
    await mkdir(lookalikeDir, { recursive: true });
    await writeFile(join(lookalikeDir, 'notes.txt'), 'not source state');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('Bar.source/notes.txt')).toBe(true);
  });

  it('does NOT exclude a plain file (not a directory) literally named "<plugin>.source" (directory-only guard)', async () => {
    await writeFile(join(modARoot, PLUGIN), 'PLUGINBYTES');
    await writeFile(join(modARoot, `${PLUGIN}.source`), 'just a file, not a source tree');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has(`${PLUGIN}.source`)).toBe(true);
  });

  // Mutation review (#374): the guard that limits the loop to directories actually ending in
  // ".source" was unproven — nothing exercised an ordinary directory whose name would spuriously
  // match a sibling file if that guard's suffix check were skipped. "BarABCDEFG" (a real sibling
  // "Bar" plus 7 arbitrary, non-".source" characters) would incorrectly resolve to "Bar" if the
  // code sliced its last 7 characters unconditionally instead of first confirming the ".source"
  // suffix — this pins that the suffix check, not just the slice arithmetic, is load-bearing.
  it('never treats an ordinary non-".source" directory as source state, even when slicing its last 7 characters would spuriously match a sibling file', async () => {
    await writeFile(join(modARoot, 'Bar'), 'PLUGINBYTES');
    await mkdir(join(modARoot, 'BarABCDEFG'), { recursive: true }); // "Bar" + 7 chars, not ".source"
    await writeFile(join(modARoot, 'BarABCDEFG', 'note.txt'), 'ordinary mod content');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('BarABCDEFG/note.txt')).toBe(true);
  });

  // Mutation review (#374): root-only scoping (SourceRecordPath.For is always root-relative,
  // per the doc comment above) was unproven — every prior test placed its ".source" folder at
  // the mod root. A folder below the root sharing the exact same shape (plugin + ".source"
  // sibling, both at that nested level) must stay visible; the exclusion only ever applies at
  // the top of the mod tree.
  it('does not apply the source exclusion below the mod root — a nested "<plugin>.source" folder is not source state', async () => {
    const nestedDir = join(modARoot, 'nested');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, PLUGIN), 'PLUGINBYTES');
    const nestedSourceDir = join(nestedDir, `${PLUGIN}.source`);
    await mkdir(nestedSourceDir, { recursive: true });
    await writeFile(join(nestedSourceDir, 'note.txt'), 'not real source state at this depth');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has(`nested/${PLUGIN}.source/note.txt`)).toBe(true);
  });
});

// #441: the layout root's own exclusion — a plain root "source/" folder (SourceRecordPath's outer
// layout, replacing the per-plugin "<plugin>.source/" sibling tree the block above still guards)
// and, separately, any dot-prefixed entry at any depth (closing #438's undetected ".git"). Neither
// rule needs the sibling-plugin check above: a root "source/" folder is excluded unconditionally,
// which is what closes the #436 orphaning trap by construction rather than by a guard that could
// itself be defeated the same way the old one was.
describe('buildFileConflictIndex — root "source/" and dot-prefixed exclusion (#441, closes #438)', () => {
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

  it('excludes a .git directory at the mod root, at any depth beneath it (closes #438)', async () => {
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
    // #436: an orphaned tree for a plugin that doesn't even exist in this mod. The old sibling
    // guard would have left this deployable; the new rule excludes the whole root folder outright.
    await mkdir(join(modARoot, 'source', 'DeletedPlugin.esp', 'npc_'), { recursive: true });
    await writeFile(join(modARoot, 'source', 'DeletedPlugin.esp', 'npc_', '000800.json'), '{}');
    await mkdir(join(modARoot, 'SOURCE'), { recursive: true }); // a second mod could ship any casing
    await writeFile(join(modARoot, 'SOURCE', 'stray.json'), '{}');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect([...index.files].map((e) => e.relativePath)).toEqual(['Plugin.esp']);
  });

  // Root-anchoring proof: Papyrus ships its own scripts nested under "Scripts/Source/…", never at
  // the mod root — SourceRecordPath's own layout is what "source" means only at the root, so a
  // nested directory of that exact name must still deploy normally.
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

// #84 regression backstop: prove the override-order direction against a REAL MO2 instance, not
// just synthetic fixtures — the direction was inverted for a long time (bottom-of-modlist.txt
// picked as winner) before being corrected; this is what stands between that bug and it silently
// re-inverting again. Opt-in like modlistText.test.ts's own LitR round-trip: skipped when the
// instance is absent (CI, Windows, other machines), same MEDIT_LITR_INSTANCE override.
const litrInstance = process.env.MEDIT_LITR_INSTANCE ?? join(homedir(), 'Games', 'FO4', 'LitR');
const litrModlistPath = join(litrInstance, 'profiles', 'Life in the Ruins', 'modlist.txt');
const hasLitr = existsSync(litrModlistPath);

// #84 review: the game directory a badge/deploy check against the real instance needs — read
// from ModOrganizer.ini in principle, but this opt-in test is already coupled to this specific
// real instance's on-disk shape (its exact mod names), so hardcoding the sibling "Stock Game
// Folder" is no more fragile than the mod names above and avoids pulling in gameDirectory.ts's
// full resolver (config → ini → Steam scan) for a read-only masters lookup.
const litrVanillaData = join(litrInstance, 'Stock Game Folder', 'Data');

function fakeReporter() {
  return { report: () => {} };
}

describe.skipIf(!hasLitr)('buildFileConflictIndex — real LitR instance (opt-in, #84)', () => {
  // Real, independently-verifiable conflict discovered in the live LitR modlist (not planted):
  // "Pipboy Arm Fix for Grafs Assaultron Armor" sits above "Graf's Assaultron Armor" in
  // modlist.txt (nearer the winning end) and both ship the same 4 mesh files. A fix patch must
  // override what it fixes, or it isn't a fix — an oracle independent of this codebase's own
  // logic, not re-derived from it.
  const fixName = 'Pipboy Arm Fix for Grafs Assaultron Armor';
  const baseName = "Graf's Assaultron Armor";
  const contested = [
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavyf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlheavym.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumf.nif',
    'meshes/graf/assaultronarmor/assaultronarmorarmlmediumm.nif',
  ];

  // #84 review: the issue asked for "Modbench (badge + deploy)" to match MO2's winner, not just
  // the index — statusChecker.ts and deployer.ts both consume the index's winner/winnerMod with
  // no divergent logic of their own, so this proves all three agree on the same real conflict
  // rather than asserting the index alone and documenting the rest away.
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
      winnerPaths.set(relativePath, entry!.winner);
    }

    // 2. Badge — statusChecker.ts's per-mod status, built from the SAME index, against the real
    // instance (read-only: modFolderExists/readMasters stat calls, never a write).
    const vanillaMasters = await readVanillaMasters(litrVanillaData, () => {});
    const statuses = await computeModStatuses([fixEntry, baseEntry], litrInstance, index, vanillaMasters, () => {});
    expect(statuses.get(fixName)?.status).toEqual({ kind: 'overrides', count: contested.length });
    // baseName's real count is 5, not 4: it also ships GrafAssaultronArmorNoAwkcrDlc01.esl,
    // which "Lunar Arsenal Unique Replacer - Armor And Power Armor" happens to ship too (a real,
    // separate root-level name collision, confirmed on disk) — one more real conflict this mod
    // loses, unrelated to the fix pair under test but part of its honest real badge.
    expect(statuses.get(baseName)?.status).toEqual({ kind: 'conflicts', count: contested.length + 1 });
    for (const relativePath of contested) {
      // The badge's conflictLines carry the base mod's OWN on-disk casing (e.g.
      // "Meshes/Graf/...", not the lowercase form used above for index lookups) — compare
      // case-insensitively, the same rule the index itself applies (foldPath).
      expect(
        statuses
          .get(baseName)
          ?.conflictLines.some((line) => foldPath(line) === foldPath(`${relativePath} → winner: ${fixName}`)),
      ).toBe(true);
    }

    // 3. Deploy — the real deployer hardlinks the SAME real winner file (Pipboy Arm Fix's actual
    // mesh, not a synthetic fixture) into Data/. instanceRoot/gameDirectory are scratch temp
    // dirs (makeDeployerFixture) so the live LitR instance is never written to; only the winner
    // SOURCE path is real.
    const fx = await makeDeployerFixture();
    try {
      const deployIndex = makeIndex(Object.fromEntries(winnerPaths));
      await deploy(fx.instanceRoot, fx.gameDirectory, deployIndex, fakeReporter());
      for (const relativePath of contested) {
        const winner = winnerPaths.get(relativePath)!;
        const target = join(fx.gameDirectory.dataFolder, relativePath);
        const [srcStat, tgtStat] = await Promise.all([stat(winner), stat(target)]);
        expect(tgtStat.ino).toBe(srcStat.ino); // same inode == a real hardlink to the winner, not a copy
        expect(tgtStat.dev).toBe(srcStat.dev);
      }
    } finally {
      await fx.cleanup();
    }
  });

  // #84 review: vanilla-loses anchor check against the real instance. Checked for a genuine
  // pair — the real vanilla Data/ (litrVanillaData) ships every asset packed inside .ba2
  // archives with NO loose textures/meshes/sounds at all, and no root-level file (plugin, BA2,
  // ini) it ships shares a name with any enabled mod's root-level file either (diffed the full
  // real mod list against it). So there genuinely is no real vanilla-vs-mod loose-file conflict
  // pair in this instance to assert against — stating that explicitly rather than silently
  // skipping the check, per review. The invariant itself (an existing file at a target path,
  // vanilla or otherwise, is always skipped rather than overwritten) is exercised with a
  // synthetic vanilla file in deployer.test.ts's "skips and reports a winner whose Data/ path
  // already exists and is not a prior link" — that is real code, just not data this specific
  // instance can supply.
  it.todo('vanilla Data/ loose file loses to an enabled mod shipping the same file — no such real pair exists in this LitR instance; see deployer.test.ts for the synthetic-fixture proof of the invariant');
});
