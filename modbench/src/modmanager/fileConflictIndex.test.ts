import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Mod, Separator, ModlistEntry } from './model';
import { buildFileConflictIndex, rootLevelWinners } from './fileConflictIndex';

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

// #374: MEditService's per-plugin ledger text tree lands inside the mod folder itself
// (`<pluginFileName>.ledger/...`, ADR-0040) and must not deploy or appear as mod content. The
// gitdir itself needs no test here — it lives entirely outside mods/ (LedgerOptions,
// %LOCALAPPDATA%/mEdit/ledgers/) and is invisible to this walk by construction. Three-outcome
// shape mirrors the #324 hazard-class pattern: the real thing is excluded, a look-alike with no
// sibling plugin is not (over-match guard), and a plain file sharing the name is not
// (directory-only guard).
describe('buildFileConflictIndex — ledger text tree exclusion (#374)', () => {
  let instanceRoot: string;
  let modARoot: string;

  beforeEach(async () => {
    instanceRoot = await mkdtemp(join(tmpdir(), 'medit-conflict-ledger-'));
    modARoot = join(instanceRoot, 'mods', 'ModA');
    await mkdir(modARoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(instanceRoot, { recursive: true, force: true });
  });

  // Plugin base name is deliberately NOT 7 characters (mutation review, #374): ".ledger" is also
  // 7 characters, so a fixture named e.g. "Foo.esp" makes `slice(0, -LEDGER_TREE_SUFFIX.length)`
  // (strip the last 7 chars) and a mutated `slice(0, LEDGER_TREE_SUFFIX.length)` (keep the first
  // 7 chars) produce the identical string by coincidence, hiding a real off-by-construction bug.
  // "MyMod.esp" (9 chars) makes the two diverge. Every exclusion-asserting test below uses it for
  // that reason — the tests that assert something stays *visible* aren't sensitive to this
  // (nothing distinguishes front-slice from back-slice when no exclusion is expected either way).
  const PLUGIN = 'MyMod.esp';

  it('excludes the ledger text tree of a plugin actually present in the mod', async () => {
    await writeFile(join(modARoot, PLUGIN), 'PLUGINBYTES');
    const ledgerRecordDir = join(modARoot, `${PLUGIN}.ledger`, 'records', PLUGIN);
    await mkdir(ledgerRecordDir, { recursive: true });
    await writeFile(join(ledgerRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has(PLUGIN)).toBe(true);
    expect([...index.files].map((e) => e.relativePath)).toEqual([PLUGIN]);
    expect(index.filesByMod.get('ModA')?.map((f) => f.relativePath)).toEqual([PLUGIN]);
  });

  it('matches the sibling plugin case-insensitively (Bethesda plugin casing is inconsistent)', async () => {
    const upper = PLUGIN.toUpperCase();
    await writeFile(join(modARoot, upper), 'PLUGINBYTES');
    const ledgerRecordDir = join(modARoot, `${PLUGIN}.ledger`, 'records', PLUGIN);
    await mkdir(ledgerRecordDir, { recursive: true });
    await writeFile(join(ledgerRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect([...index.files].map((e) => e.relativePath)).toEqual([upper]);
  });

  // Same shape as the existing #322 symlinked-file test above ("a symlinked file participates in
  // the index like a regular file"): this walker treats a symlinked plugin as equivalent to a
  // real one everywhere else, so the sibling check must too, or an MO2-style symlinked-plugin mod
  // would acquire a ledger tree the exclusion never recognizes and it would deploy straight into
  // Data/ (review finding, #374).
  it('excludes the ledger text tree when the sibling plugin is a symlink, mirroring the #322 walk policy', async () => {
    const targetDir = join(instanceRoot, 'shared');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'real.esp'), 'PLUGINBYTES');
    await symlink(join(targetDir, 'real.esp'), join(modARoot, PLUGIN));
    const ledgerRecordDir = join(modARoot, `${PLUGIN}.ledger`, 'records', PLUGIN);
    await mkdir(ledgerRecordDir, { recursive: true });
    await writeFile(join(ledgerRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect([...index.files].map((e) => e.relativePath)).toEqual([PLUGIN]);
  });

  it('also excludes the ledger text tree when the sibling plugin symlink is dangling — accepted, not guarded against', async () => {
    await symlink(join(instanceRoot, 'does-not-exist.esp'), join(modARoot, PLUGIN));
    const ledgerRecordDir = join(modARoot, `${PLUGIN}.ledger`, 'records', PLUGIN);
    await mkdir(ledgerRecordDir, { recursive: true });
    await writeFile(join(ledgerRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    // The dangling link itself is skipped by the walker's own broken-symlink policy (#322) — the
    // ledger tree exclusion is what's under test, and it must not surface despite that.
    expect(index.files.has(`${PLUGIN}.ledger/records/${PLUGIN}/00001E.yaml`)).toBe(false);
  });

  // Mutation review (#374): nothing constrained the sibling check to files/symlinks specifically
  // — a directory sharing the plugin's exact name must NOT count as "the plugin", or a mod
  // shipping both a folder and a same-named-plus-".ledger" folder would have real content swept
  // away as if it were ledger state.
  it('does not treat a directory sharing the plugin\'s name as a valid sibling — only a file or symlink counts', async () => {
    await mkdir(join(modARoot, PLUGIN), { recursive: true }); // a directory, not the plugin file
    const ledgerRecordDir = join(modARoot, `${PLUGIN}.ledger`, 'records', PLUGIN);
    await mkdir(ledgerRecordDir, { recursive: true });
    await writeFile(join(ledgerRecordDir, '00001E.yaml'), 'record: text');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has(`${PLUGIN}.ledger/records/${PLUGIN}/00001E.yaml`)).toBe(true);
  });

  it('does NOT exclude a "*.ledger" folder with no matching plugin file — an author-named folder is ordinary content (#324 over-match guard)', async () => {
    const lookalikeDir = join(modARoot, 'Bar.ledger');
    await mkdir(lookalikeDir, { recursive: true });
    await writeFile(join(lookalikeDir, 'notes.txt'), 'not ledger state');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('Bar.ledger/notes.txt')).toBe(true);
  });

  it('does NOT exclude a plain file (not a directory) literally named "<plugin>.ledger" (directory-only guard)', async () => {
    await writeFile(join(modARoot, PLUGIN), 'PLUGINBYTES');
    await writeFile(join(modARoot, `${PLUGIN}.ledger`), 'just a file, not a ledger tree');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has(`${PLUGIN}.ledger`)).toBe(true);
  });

  // Mutation review (#374): the guard that limits the loop to directories actually ending in
  // ".ledger" was unproven — nothing exercised an ordinary directory whose name would spuriously
  // match a sibling file if that guard's suffix check were skipped. "BarABCDEFG" (a real sibling
  // "Bar" plus 7 arbitrary, non-".ledger" characters) would incorrectly resolve to "Bar" if the
  // code sliced its last 7 characters unconditionally instead of first confirming the ".ledger"
  // suffix — this pins that the suffix check, not just the slice arithmetic, is load-bearing.
  it('never treats an ordinary non-".ledger" directory as ledger state, even when slicing its last 7 characters would spuriously match a sibling file', async () => {
    await writeFile(join(modARoot, 'Bar'), 'PLUGINBYTES');
    await mkdir(join(modARoot, 'BarABCDEFG'), { recursive: true }); // "Bar" + 7 chars, not ".ledger"
    await writeFile(join(modARoot, 'BarABCDEFG', 'note.txt'), 'ordinary mod content');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has('BarABCDEFG/note.txt')).toBe(true);
  });

  // Mutation review (#374): root-only scoping (LedgerRecordPath.For is always root-relative,
  // per the doc comment above) was unproven — every prior test placed its ".ledger" folder at
  // the mod root. A folder below the root sharing the exact same shape (plugin + ".ledger"
  // sibling, both at that nested level) must stay visible; the exclusion only ever applies at
  // the top of the mod tree.
  it('does not apply the ledger exclusion below the mod root — a nested "<plugin>.ledger" folder is not ledger state', async () => {
    const nestedDir = join(modARoot, 'nested');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, PLUGIN), 'PLUGINBYTES');
    const nestedLedgerDir = join(nestedDir, `${PLUGIN}.ledger`);
    await mkdir(nestedLedgerDir, { recursive: true });
    await writeFile(join(nestedLedgerDir, 'note.txt'), 'not real ledger state at this depth');

    const index = await buildFileConflictIndex([mod('ModA')], instanceRoot, () => {});

    expect(index.files.has(`nested/${PLUGIN}.ledger/note.txt`)).toBe(true);
  });
});
