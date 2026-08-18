import { describe, it, expect, afterEach } from 'vitest';
import { link, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deploy, isDeployed, listRelativeFiles, purge } from './deployer';
import { makeDeployerFixture, makeIndex, type DeployerFixture } from './test/deployerFixture';
import { buildFileConflictIndex } from './fileConflictIndex';
import type { ModlistEntry } from './model';

const CORRUPT_MANIFEST = '{not json';

function fakeReporter() {
  const reports: { severity: string; message: string; detail?: string }[] = [];
  return { reports, report: (severity: string, message: string, detail?: string) => reports.push({ severity, message, detail }) };
}

const MANIFEST = ['mods', '.medit-manifest.json'];

describe('deploy', () => {
  let fx: DeployerFixture;
  afterEach(() => fx?.cleanup());

  it('hardlinks one winner into an empty Data/ and writes a manifest with links + a preExisting snapshot', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    const index = makeIndex({ 'textures/foo.dds': source });

    await deploy(fx.instanceRoot, fx.gameDirectory, index, fakeReporter());

    const target = join(fx.gameDirectory.dataFolder, 'textures/foo.dds');
    // Same inode as the mod source → a real hardlink, not a copy.
    const [srcStat, tgtStat] = await Promise.all([stat(source), stat(target)]);
    expect(tgtStat.ino).toBe(srcStat.ino);

    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['textures/foo.dds']);
    expect(manifest.preExisting).toEqual([]);
  });

  // fs.symlink needs admin rights or Developer Mode on Windows (#185 plans a Windows CI
  // leg) — skip there rather than fail for an environment reason, not a code one.
  it.skipIf(process.platform === 'win32')(
    'deploys a symlinked file as a real hardlink to its target, not a duplicated symlink (#322)',
    async () => {
      fx = await makeDeployerFixture();
      const target = await fx.writeModFile('ModA', 'shared/real.dds', 'REAL');
      const linkPath = join(fx.instanceRoot, 'mods', 'ModA', 'linked.dds');
      await symlink(target, linkPath);
      const entries: ModlistEntry[] = [{ kind: 'mod', name: 'ModA', enabled: true }];
      const index = await buildFileConflictIndex(entries, fx.instanceRoot, () => {});

      await deploy(fx.instanceRoot, fx.gameDirectory, index, fakeReporter());

      const deployedPath = join(fx.gameDirectory.dataFolder, 'linked.dds');
      // A real hardlink to the resolved target, not a duplicated symlink — fs.link's final
      // path component doesn't dereference on Linux, so linking the symlink's own path
      // would otherwise land a second, possibly-broken symlink in Data/ (#322).
      expect((await lstat(deployedPath)).isSymbolicLink()).toBe(false);
      const [srcStat, tgtStat] = await Promise.all([stat(target), stat(deployedPath)]);
      expect(tgtStat.ino).toBe(srcStat.ino);
      expect(await readFile(deployedPath, 'utf8')).toBe('REAL');
    },
  );

  // #374 (AC1): a tracked mod deploys byte-identically to the untracked equivalent — no vcs
  // state, no ledger text tree in the game directory. The gitdir needs no test here — it lives
  // outside mods/ entirely (LedgerOptions) and this walk never reaches it; the ledger text tree
  // does land inside the mod folder and is what fileConflictIndex.ts's exclusion (#374) keeps
  // out of the index deploy() consumes.
  it('deploys only the plugin, never its ledger text tree, when a mod has acquired a repo', async () => {
    fx = await makeDeployerFixture();
    // "MyMod.esp" (9 chars), deliberately not 7 — see fileConflictIndex.test.ts's #374 ledger
    // block for why a 7-char plugin name (matching ".ledger"'s own length) can hide a real bug.
    await fx.writeModFile('ModA', 'MyMod.esp', 'PLUGINBYTES');
    await fx.writeModFile('ModA', 'MyMod.esp.ledger/records/MyMod.esp/00001E.yaml', 'record: text');
    const entries: ModlistEntry[] = [{ kind: 'mod', name: 'ModA', enabled: true }];
    const index = await buildFileConflictIndex(entries, fx.instanceRoot, () => {});

    await deploy(fx.instanceRoot, fx.gameDirectory, index, fakeReporter());

    const deployedFiles = await listRelativeFiles(fx.gameDirectory.dataFolder);
    expect(deployedFiles).toEqual(['MyMod.esp']);
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['MyMod.esp']);
  });

  // #374 (AC2): "manifest hashing yields identical results... before and after a mod acquires a
  // repo" — there is no manifest hashing anywhere in Mod Management today (#388 owns hashing
  // pristine binaries for provenance, a different job), so this reads the criterion as *manifest
  // identity* across the tracked/untracked boundary and proves that directly: same plugin bytes,
  // same manifest, whether or not the ledger tree exists alongside it.
  it('produces an identical manifest before and after the same mod acquires a repo, and never rewrites the plugin bytes', async () => {
    fx = await makeDeployerFixture();
    // "MyMod.esp" (9 chars), deliberately not 7 — same reason as the test above.
    const pluginPath = await fx.writeModFile('ModA', 'MyMod.esp', 'PLUGINBYTES');
    const entries: ModlistEntry[] = [{ kind: 'mod', name: 'ModA', enabled: true }];

    const beforeIndex = await buildFileConflictIndex(entries, fx.instanceRoot, () => {});
    await deploy(fx.instanceRoot, fx.gameDirectory, beforeIndex, fakeReporter());
    const manifestBefore = await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8');
    const pluginBytesBefore = await readFile(pluginPath, 'utf8');
    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());

    // Simulate the mod acquiring a repo: RecordVendor never rewrites the plugin binary (traced
    // in MEditService.Core/Ledger/RecordVendor.cs — it serializes only to the ledger text path),
    // it only adds the text tree alongside the untouched plugin.
    await fx.writeModFile('ModA', 'MyMod.esp.ledger/records/MyMod.esp/00001E.yaml', 'record: text');
    const afterIndex = await buildFileConflictIndex(entries, fx.instanceRoot, () => {});
    await deploy(fx.instanceRoot, fx.gameDirectory, afterIndex, fakeReporter());
    const manifestAfter = await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8');
    const pluginBytesAfter = await readFile(pluginPath, 'utf8');

    expect(manifestAfter).toBe(manifestBefore);
    expect(pluginBytesAfter).toBe(pluginBytesBefore);
  });

  it('reports the cross-volume-specific message (and does not throw, and never the "already exists" message) when a winner\'s link fails with EXDEV — e.g. a symlinked file resolving onto another volume (#322)', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const exdevError = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    const linkFn = () => Promise.reject(exdevError);
    const reporter = fakeReporter();

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), reporter, { linkFn });

    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow(); // nothing landed
    // The cross-volume-specific message, naming the file — not just *some* warning with the
    // filename in its detail, which the pre-existing "already exists in Data/" skip message
    // would equally satisfy if the outcome landed in the wrong bucket.
    expect(
      reporter.reports.some(
        (r) => r.severity === 'warning' && r.message.includes('different drive') && r.detail?.includes('mod.esp'),
      ),
    ).toBe(true);
    expect(reporter.reports.some((r) => r.message.includes('already exists in Data/'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual([]); // not recorded as linked — retried on the next deploy
  });

  it('rethrows a non-EXDEV link failure rather than treating it as skipped or cross-volume', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const permError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const linkFn = () => Promise.reject(permError);

    await expect(
      deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), fakeReporter(), { linkFn }),
    ).rejects.toThrow(/EACCES|permission denied/);
  });

  it('skips a mod\'s root/ files — they map to the game root, not Data/', async () => {
    fx = await makeDeployerFixture();
    const dataFile = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDS');
    const rootFile = await fx.writeModFile('F4SE', 'root/f4se_loader.exe', 'EXE');
    const index = makeIndex({ 'textures/foo.dds': dataFile, 'root/f4se_loader.exe': rootFile });

    await deploy(fx.instanceRoot, fx.gameDirectory, index, fakeReporter());

    // root/ file must NOT be linked under Data/
    await expect(stat(join(fx.gameDirectory.dataFolder, 'root/f4se_loader.exe'))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['textures/foo.dds']);
  });

  it('copies the active profile\'s load-order file to the resolved target and purge removes it', async () => {
    fx = await makeDeployerFixture();
    const profileDir = join(fx.instanceRoot, 'profiles', 'Default');
    await mkdir(profileDir, { recursive: true });
    const source = join(profileDir, 'plugins.txt');
    await writeFile(source, '# managed\r\n*ModA.esp\r\n');
    const target = join(fx.instanceRoot, 'appdata', 'plugins.txt');
    const source2 = join(profileDir, 'loadorder.txt');
    await writeFile(source2, '*ModA.esp\r\n');
    const target2 = join(fx.instanceRoot, 'appdata', 'loadorder.txt');
    const index = makeIndex({});

    await deploy(fx.instanceRoot, fx.gameDirectory, index, fakeReporter(), {
      loadOrder: [{ source, target }, { source: source2, target: target2 }],
    });

    expect(await readFile(target, 'utf8')).toBe('# managed\r\n*ModA.esp\r\n');
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.loadOrder).toEqual([target, target2]);

    // target2 is already gone (e.g., manually removed) before purge runs — its rm(force:true)
    // must tolerate an already-absent path and not throw.
    await rm(target2, { force: true });

    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());
    await expect(stat(target)).rejects.toThrow();
    await expect(stat(target2)).rejects.toThrow();
  });

  it('re-deploying with the same load-order target does not fail on the already-existing directory', async () => {
    fx = await makeDeployerFixture();
    const profileDir = join(fx.instanceRoot, 'profiles', 'Default');
    await mkdir(profileDir, { recursive: true });
    const source = join(profileDir, 'plugins.txt');
    await writeFile(source, '*ModA.esp\r\n');
    const target = join(fx.instanceRoot, 'appdata', 'plugins.txt');
    const opts = { loadOrder: [{ source, target }] };

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({}), fakeReporter(), opts);
    // appdata/ now already exists — the second deploy's mkdir must tolerate that, not throw.
    const reporter = fakeReporter();
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({}), reporter, opts);

    expect(reporter.reports).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe('*ModA.esp\r\n');
  });

  it('skips and reports a winner whose Data/ path already exists and is not a prior link', async () => {
    fx = await makeDeployerFixture();
    await fx.writeDataFile('textures/foo.dds', 'VANILLA'); // pre-existing vanilla file
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'MODDED');
    const index = makeIndex({ 'textures/foo.dds': source });
    const reporter = fakeReporter();

    await deploy(fx.instanceRoot, fx.gameDirectory, index, reporter);

    // The vanilla file is untouched (not overwritten by the mod link).
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'), 'utf8')).toBe('VANILLA');
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual([]);
    // ADR-0026 integrity tier: this is mandatory, so the severity tier matters, not just that
    // some report happened to fire.
    expect(reporter.reports.some((r) => r.severity === 'warning' && r.detail?.includes('textures/foo.dds'))).toBe(true);
  });

  it('reports nothing when nothing was skipped, the load order wrote successfully, and both are on the same volume', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const reporter = fakeReporter();

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), reporter);

    // ADR-0026 rejects notification fatigue: nothing went wrong, so nothing should surface.
    expect(reporter.reports).toEqual([]);
  });

  it('re-running deploy after a reorder relinks only the changed winner, leaving others alone', async () => {
    fx = await makeDeployerFixture();
    const a1 = await fx.writeModFile('ModA', 'p.dds', 'A');
    const b1 = await fx.writeModFile('ModB', 'p.dds', 'B');
    const x = await fx.writeModFile('ModX', 'other.dds', 'X');

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'p.dds': a1, 'other.dds': x }), fakeReporter());

    const relinked: string[] = [];
    const spyLink = async (source: string, target: string) => { relinked.push(target); await link(source, target); };
    // Reorder: ModB now wins p.dds; other.dds is unchanged.
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'p.dds': b1, 'other.dds': x }), fakeReporter(), {
      linkFn: spyLink,
    });

    expect(relinked).toEqual([join(fx.gameDirectory.dataFolder, 'p.dds')]);
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'p.dds'), 'utf8')).toBe('B');
  });

  it('re-deploy removes a prior link whose path is no longer a winner (mod disabled)', async () => {
    fx = await makeDeployerFixture();
    const a = await fx.writeModFile('ModA', 'a.esp', 'A');
    const b = await fx.writeModFile('ModB', 'b.esp', 'B');
    const c = await fx.writeModFile('ModC', 'c.esp', 'C');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'a.esp': a, 'b.esp': b, 'c.esp': c }), fakeReporter());

    // c.esp's link is already gone from Data/ (e.g., manually removed) before the stale-link
    // cleanup runs — its rm(force:true) must tolerate this, not throw, and must not block
    // b.esp's (still-present) cleanup.
    await rm(join(fx.gameDirectory.dataFolder, 'c.esp'), { force: true });

    // ModB and ModC disabled → no longer in the index.
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'a.esp': a }), fakeReporter());

    await expect(stat(join(fx.gameDirectory.dataFolder, 'b.esp'))).rejects.toThrow();
    await expect(stat(join(fx.gameDirectory.dataFolder, 'c.esp'))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['a.esp']);

    // Purge must not misfile the (already removed) b.esp/c.esp into overwrite/.
    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());
    await expect(stat(join(fx.instanceRoot, 'overwrite', 'b.esp'))).rejects.toThrow();
    await expect(stat(join(fx.instanceRoot, 'overwrite', 'c.esp'))).rejects.toThrow();
  });

  it('purge deletes the manifested links only, leaving preExisting files untouched', async () => {
    fx = await makeDeployerFixture();
    await fx.writeDataFile('Fallout4.esm', 'VANILLA'); // preExisting
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const source2 = await fx.writeModFile('ModB', 'mod2.esp', 'MOD2');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source, 'mod2.esp': source2 }), fakeReporter());

    // mod2.esp's link is already gone from Data/ (e.g., manually removed) before purge runs —
    // its rm(force:true) must tolerate this, not throw.
    await rm(join(fx.gameDirectory.dataFolder, 'mod2.esp'), { force: true });

    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());

    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow();
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'Fallout4.esm'), 'utf8')).toBe('VANILLA');
  });

  it('purge moves a stray Data/ file (neither link nor preExisting) into instanceRoot/overwrite/', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), fakeReporter());
    // The game (or F4SE/MCM) writes a new file into Data/ while running.
    await fx.writeDataFile('F4SE/foo.log', 'GENERATED');
    const reporter = fakeReporter();

    await purge(fx.instanceRoot, fx.gameDirectory, reporter);

    // Moved out of Data/ into the instance's overwrite/ (sibling of mods/, not mods/overwrite/).
    await expect(stat(join(fx.gameDirectory.dataFolder, 'F4SE/foo.log'))).rejects.toThrow();
    expect(await readFile(join(fx.instanceRoot, 'overwrite', 'F4SE/foo.log'), 'utf8')).toBe('GENERATED');
    // The move succeeded — nothing to report.
    expect(reporter.reports).toEqual([]);
  });

  it('reports (does not silently drop) a stray Data/ file it could not move into overwrite/', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), fakeReporter());
    await fx.writeDataFile('F4SE/foo.log', 'GENERATED');
    // Block the move target: a directory already occupies where the stray file would land.
    await mkdir(join(fx.instanceRoot, 'overwrite', 'F4SE', 'foo.log'), { recursive: true });
    const reporter = fakeReporter();

    await purge(fx.instanceRoot, fx.gameDirectory, reporter);

    // Reports the original rename failure directly — a non-EXDEV error must be rethrown, not
    // masked behind a second, different failure from wrongly attempting the copy+delete fallback.
    expect(reporter.reports.some((r) => r.severity === 'warning' && r.detail?.includes('F4SE/foo.log') && r.detail?.includes('rename'))).toBe(true);
    // Still in Data/ — purge did not silently lose it.
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'F4SE/foo.log'), 'utf8')).toBe('GENERATED');
  });

  it('falls back to copy+delete when a stray file\'s move fails with EXDEV (cross-volume overwrite/)', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), fakeReporter());
    await fx.writeDataFile('F4SE/foo.log', 'GENERATED');
    const exdevError = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    const renameFn = () => Promise.reject(exdevError);
    const reporter = fakeReporter();

    await purge(fx.instanceRoot, fx.gameDirectory, reporter, { renameFn });

    // Fell back to copy+delete: landed in overwrite/, gone from Data/.
    expect(await readFile(join(fx.instanceRoot, 'overwrite', 'F4SE/foo.log'), 'utf8')).toBe('GENERATED');
    await expect(stat(join(fx.gameDirectory.dataFolder, 'F4SE/foo.log'))).rejects.toThrow();
    // Succeeded via the fallback — nothing to report.
    expect(reporter.reports).toEqual([]);
  });

  it('prunes a now-empty Data/ directory but preserves one that still holds a preExisting file', async () => {
    fx = await makeDeployerFixture();
    await fx.writeDataFile('Meshes/vanilla.nif', 'VANILLA'); // preExisting, nested — Meshes/ must survive
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), fakeReporter());
    // Stray, nested — Meshes/Stray/ must be pruned once emptied by the move.
    await fx.writeDataFile('Meshes/Stray/junk.tmp', 'GENERATED');

    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());

    await expect(stat(join(fx.gameDirectory.dataFolder, 'Meshes/Stray'))).rejects.toThrow();
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'Meshes/vanilla.nif'), 'utf8')).toBe('VANILLA');
  });

  it('purge tolerates a manifest written before loadOrder tracking existed (no loadOrder field)', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), fakeReporter());
    const manifestFile = join(fx.instanceRoot, ...MANIFEST);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    delete manifest.loadOrder;
    await writeFile(manifestFile, JSON.stringify(manifest));
    const reporter = fakeReporter();

    await purge(fx.instanceRoot, fx.gameDirectory, reporter);

    expect(reporter.reports).toEqual([]);
    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow();
  });

  it('still writes the manifest (and reports) when a load-order source is missing, so links stay purgeable', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const reporter = fakeReporter();

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), reporter, {
      loadOrder: [{ source: join(fx.instanceRoot, 'profiles', 'Nope', 'plugins.txt'), target: join(fx.instanceRoot, 'appdata', 'plugins.txt') }],
    });

    // The link and manifest exist despite the load-order copy failing.
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['mod.esp']);
    expect(manifest.loadOrder).toEqual([]);
    expect(reporter.reports.some((r) => r.severity === 'warning')).toBe(true);

    // …and purge can therefore clean the link.
    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());
    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow();
  });

  it('blocks hardlinking and reports (never silently symlinks) when mods/ and the game dir are on different volumes', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const reporter = fakeReporter();
    const modsDir = join(fx.instanceRoot, 'mods');
    // Fake different device ids — a real second volume isn't guaranteed on CI.
    const statFn = (p: string) => Promise.resolve({ dev: p === modsDir ? 1 : 2, ino: 0 });

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), reporter, { statFn });

    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow(); // nothing linked
    await expect(stat(join(fx.instanceRoot, ...MANIFEST))).rejects.toThrow(); // no manifest written
    expect(reporter.reports.some((r) => r.severity === 'error')).toBe(true);
  });

  // Proton/Wine resolves paths case-insensitively over ext4's case-sensitive
  // mods/ — two mods providing case-variant paths (Textures/Foo.dds vs
  // textures/foo.dds) are the SAME file to the game, but DIFFERENT physical
  // paths on ext4. The winner map only ever has one entry per folded path
  // (fileConflictIndex's job), so the deployer must link exactly the winner's
  // own casing and never both (#128).
  it('links exactly one file for a case-variant winner, at the winner\'s own casing', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'Textures/Foo.dds', 'A');
    const index = makeIndex({ 'Textures/Foo.dds': source });

    await deploy(fx.instanceRoot, fx.gameDirectory, index, fakeReporter());

    await expect(stat(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'))).resolves.toBeTruthy();
    // The losing provider's own casing was never separately linked.
    await expect(stat(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['Textures/Foo.dds']);
  });

  it('removes the old-cased link and creates the new-cased one when the winner\'s casing changes on redeploy', async () => {
    fx = await makeDeployerFixture();
    const a = await fx.writeModFile('ModA', 'Textures/Foo.dds', 'A');
    const b = await fx.writeModFile('ModB', 'textures/foo.dds', 'B');

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'Textures/Foo.dds': a }), fakeReporter());
    await expect(stat(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'))).resolves.toBeTruthy();

    // Reorder: ModB now wins the same logical file, with a different casing.
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'textures/foo.dds': b }), fakeReporter());

    // Old-cased target is gone — never orphaned in Data/.
    await expect(stat(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'))).rejects.toThrow();
    // New-cased target is present with the new winner's content.
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'), 'utf8')).toBe('B');

    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['textures/foo.dds']); // never both casings
  });

  it('tolerates the old-cased link already being gone when the winner\'s casing changes on redeploy', async () => {
    fx = await makeDeployerFixture();
    const a = await fx.writeModFile('ModA', 'Textures/Foo.dds', 'A');
    const b = await fx.writeModFile('ModB', 'textures/foo.dds', 'B');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'Textures/Foo.dds': a }), fakeReporter());

    // The old-cased target is already gone from Data/ (e.g., manually removed) before the
    // casing-change cleanup runs — its rm(force:true) must tolerate this, not throw.
    await rm(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'), { force: true });

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'textures/foo.dds': b }), fakeReporter());

    expect(await readFile(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'), 'utf8')).toBe('B');
  });

  it('purge after a casing change cleans up correctly, without misfiling into overwrite/', async () => {
    fx = await makeDeployerFixture();
    const a = await fx.writeModFile('ModA', 'Textures/Foo.dds', 'A');
    const b = await fx.writeModFile('ModB', 'textures/foo.dds', 'B');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'Textures/Foo.dds': a }), fakeReporter());
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'textures/foo.dds': b }), fakeReporter());

    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());

    await expect(stat(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).rejects.toThrow();
    await expect(stat(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'))).rejects.toThrow();
    // Nothing stray got moved into overwrite/ under either casing.
    await expect(stat(join(fx.instanceRoot, 'overwrite', 'textures/foo.dds'))).rejects.toThrow();
    await expect(stat(join(fx.instanceRoot, 'overwrite', 'Textures/Foo.dds'))).rejects.toThrow();
  });

  it('aborts and reports (never re-snapshots Data/) when the manifest is corrupt', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), fakeReporter());

    const target = join(fx.gameDirectory.dataFolder, 'mod.esp');
    const [origStat] = await Promise.all([stat(target)]);

    // Corrupt the manifest in place, as if a crash truncated the write.
    const manifestFile = join(fx.instanceRoot, ...MANIFEST);
    await writeFile(manifestFile, CORRUPT_MANIFEST);

    const source2 = await fx.writeModFile('ModB', 'other.esp', 'OTHER');
    const reporter = fakeReporter();
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source, 'other.esp': source2 }), reporter);

    // Surfaced on the integrity tier, not silent.
    expect(reporter.reports.some((r) => r.severity === 'error' && /manifest/i.test(r.message))).toBe(true);

    // Manifest on disk is untouched — not overwritten by a fresh snapshot.
    expect(await readFile(manifestFile, 'utf8')).toBe(CORRUPT_MANIFEST);

    // The original link from the first deploy is untouched (same inode).
    const afterStat = await stat(target);
    expect(afterStat.ino).toBe(origStat.ino);

    // Nothing from the second deploy's index got linked.
    await expect(stat(join(fx.gameDirectory.dataFolder, 'other.esp'))).rejects.toThrow();
  });

  it('aborts and reports (as corrupt) when the manifest path is unreadable, not just when its content is invalid JSON', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    // A directory sitting where the manifest file should be: readFile fails with something
    // other than ENOENT (EISDIR) — the other half of "corrupt" besides unparseable content.
    await mkdir(join(fx.instanceRoot, ...MANIFEST), { recursive: true });
    const reporter = fakeReporter();

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), reporter);

    expect(reporter.reports.some((r) => r.severity === 'error' && /manifest/i.test(r.message))).toBe(true);
    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow();
  });
});

describe('isDeployed', () => {
  let fx: DeployerFixture;
  afterEach(() => fx?.cleanup());

  it('is false before any deploy and true once a manifest exists', async () => {
    fx = await makeDeployerFixture();
    expect(await isDeployed(fx.instanceRoot)).toBe(false);

    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({}), fakeReporter());

    expect(await isDeployed(fx.instanceRoot)).toBe(true);
  });
});

describe('purge', () => {
  let fx: DeployerFixture;
  afterEach(() => fx?.cleanup());

  it('aborts and reports (never touches Data/ or deletes the manifest) when the manifest is corrupt', async () => {
    fx = await makeDeployerFixture();
    await fx.writeDataFile('Fallout4.esm', 'VANILLA'); // preExisting
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), fakeReporter());

    const manifestFile = join(fx.instanceRoot, ...MANIFEST);
    await writeFile(manifestFile, CORRUPT_MANIFEST);

    const reporter = fakeReporter();
    await purge(fx.instanceRoot, fx.gameDirectory, reporter);

    expect(reporter.reports.some((r) => r.severity === 'error' && /manifest/i.test(r.message))).toBe(true);

    // The linked file is still present — purge did not clean it up.
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'mod.esp'), 'utf8')).toBe('MOD');
    // The preExisting vanilla file is untouched.
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'Fallout4.esm'), 'utf8')).toBe('VANILLA');
    // The corrupted manifest survives as evidence — not deleted.
    expect(await readFile(manifestFile, 'utf8')).toBe(CORRUPT_MANIFEST);
  });
});
