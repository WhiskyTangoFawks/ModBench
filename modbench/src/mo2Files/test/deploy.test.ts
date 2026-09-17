import { describe, it, expect, afterEach } from 'vitest';
import { link, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deployToGameData, purgeFromGameData, listRelativeFiles, manifestFile, exists, parseManifest,
  type DeployLink, type DeployOutcome, type DeployWarning, type PurgeOutcome,
} from '../files';
import { makeDeployerFixture, type DeployerFixture } from '../../test/mo2/deployerFixture';
import { buildFileConflictIndex } from '../../instance/fileConflictIndex';
import type { ModlistEntry } from '../../mo2Codecs/modlistText';

const CORRUPT_MANIFEST = '{not json';

const MANIFEST = ['mods', '.medit-manifest.json'];

function toLinks(files: Record<string, string>): DeployLink[] {
  return Object.entries(files).map(([relativePath, source]) => ({ relativePath, source }));
}

function linksFromWinners(files: Iterable<{ relativePath: string; winner: string }>): DeployLink[] {
  return [...files].map((entry) => ({ relativePath: entry.relativePath, source: entry.winner }));
}

// Fails loudly with the refusal, rather than a generic "false is not true", when a test
// expected a write but the run aborted.
function assertWrote(outcome: DeployOutcome | PurgeOutcome): DeployWarning[] {
  if (!outcome.wrote) throw new Error(`expected wrote:true, got a refusal: ${outcome.refusal}`);
  return outcome.warnings;
}

function assertRefused(outcome: DeployOutcome | PurgeOutcome): string {
  if (outcome.wrote) throw new Error('expected wrote:false, got a write');
  if (outcome.refusal === undefined) throw new Error('expected a refusal, got a legitimate no-op');
  return outcome.refusal;
}

describe('deployToGameData', () => {
  let fx: DeployerFixture | undefined;
  afterEach(() => fx?.cleanup());

  it('hardlinks one winner into an empty Data/ and writes a manifest with links + a preExisting snapshot', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');

    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'textures/foo.dds': source }));

    const target = join(fx.gameDirectory.dataFolder, 'textures/foo.dds');
    // Same inode as the mod source → a real hardlink, not a copy.
    const [srcStat, tgtStat] = await Promise.all([stat(source), stat(target)]);
    expect(tgtStat.ino).toBe(srcStat.ino);

    const manifest = parseManifest(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['textures/foo.dds']);
    expect(manifest.preExisting).toEqual([]);
  });

  // fs.symlink needs admin rights or Developer Mode on Windows — skip there
  // rather than fail for an environment reason, not a code one.
  it.skipIf(process.platform === 'win32')(
    'deploys a symlinked file as a real hardlink to its target, not a duplicated symlink',
    async () => {
      fx = await makeDeployerFixture();
      const target = await fx.writeModFile('ModA', 'shared/real.dds', 'REAL');
      const linkPath = join(fx.instanceRoot, 'mods', 'ModA', 'linked.dds');
      await symlink(target, linkPath);
      const entries: ModlistEntry[] = [{ kind: 'mod', name: 'ModA', enabled: true }];
      const index = await buildFileConflictIndex(entries, fx.instanceRoot, () => {});

      await deployToGameData(fx.instanceRoot, fx.gameDirectory, linksFromWinners(index.files));

      const deployedPath = join(fx.gameDirectory.dataFolder, 'linked.dds');
      // A real hardlink to the resolved target, not a duplicated symlink — fs.link's final
      // path component doesn't dereference on Linux, so linking the symlink's own path
      // would otherwise land a second, possibly-broken symlink in Data/.
      expect((await lstat(deployedPath)).isSymbolicLink()).toBe(false);
      const [srcStat, tgtStat] = await Promise.all([stat(target), stat(deployedPath)]);
      expect(tgtStat.ino).toBe(srcStat.ino);
      expect(await readFile(deployedPath, 'utf8')).toBe('REAL');
    },
  );

  // End to end through the real walk, not just at the index level.
  it('deploys neither .git nor the root source/ folder, even though both exist in the mod', async () => {
    fx = await makeDeployerFixture();
    await fx.writeModFile('ModA', 'MyMod.esp', 'PLUGINBYTES');
    await fx.writeModFile('ModA', '.git/HEAD', 'ref: refs/heads/main');
    await fx.writeModFile('ModA', '.git/objects/pack/pack-abc.pack', 'binary-ish');
    await fx.writeModFile('ModA', 'source/MyMod.esp/npc_/000800.json', '{}');
    const entries: ModlistEntry[] = [{ kind: 'mod', name: 'ModA', enabled: true }];
    const index = await buildFileConflictIndex(entries, fx.instanceRoot, () => {});

    await deployToGameData(fx.instanceRoot, fx.gameDirectory, linksFromWinners(index.files));

    const deployedFiles = await listRelativeFiles(fx.gameDirectory.dataFolder);
    expect(deployedFiles).toEqual(['MyMod.esp']);
    const manifest = parseManifest(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['MyMod.esp']);
  });

  // Manifest identity across the tracked/untracked boundary: same plugin bytes,
  // same manifest, whether or not a source text tree exists alongside the plugin.
  it('produces an identical manifest before and after the same mod acquires a repo, and never rewrites the plugin bytes', async () => {
    fx = await makeDeployerFixture();
    const pluginPath = await fx.writeModFile('ModA', 'MyMod.esp', 'PLUGINBYTES');
    const entries: ModlistEntry[] = [{ kind: 'mod', name: 'ModA', enabled: true }];

    const beforeIndex = await buildFileConflictIndex(entries, fx.instanceRoot, () => {});
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, linksFromWinners(beforeIndex.files));
    const manifestBefore = await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8');
    const pluginBytesBefore = await readFile(pluginPath, 'utf8');
    await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);

    // Simulate the mod acquiring a repo: serialization never rewrites the plugin binary (Track
    // writes only to the source text path — MEditService.Commands/Edits/TrackService.cs), it only
    // adds the text tree alongside the untouched plugin.
    await fx.writeModFile('ModA', 'source/MyMod.esp/records/MyMod.esp/00001E.yaml', 'record: text');
    const afterIndex = await buildFileConflictIndex(entries, fx.instanceRoot, () => {});
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, linksFromWinners(afterIndex.files));
    const manifestAfter = await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8');
    const pluginBytesAfter = await readFile(pluginPath, 'utf8');

    expect(manifestAfter).toBe(manifestBefore);
    expect(pluginBytesAfter).toBe(pluginBytesBefore);
  });

  it('reports the cross-volume-specific warning (and does not throw, and never the "already exists" one) when a winner\'s link fails with EXDEV — e.g. a symlinked file resolving onto another volume', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const exdevError = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    const linkFn = () => Promise.reject(exdevError);

    const outcome = await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }), [], { linkFn });

    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow(); // nothing landed
    const warnings = assertWrote(outcome);
    // The cross-volume-specific warning, naming the file — not just *some* warning with the
    // filename in its detail, which the pre-existing "already exists in Data/" skip warning
    // would equally satisfy if the outcome landed in the wrong bucket.
    expect(warnings.some((w) => w.message.includes('different drive') && w.detail?.includes('mod.esp'))).toBe(true);
    expect(warnings.some((w) => w.message.includes('already exists in Data/'))).toBe(false);
    const manifest = parseManifest(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual([]); // not recorded as linked — retried on the next deploy
  });

  it('rethrows a non-EXDEV link failure rather than treating it as skipped or cross-volume', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const permError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const linkFn = () => Promise.reject(permError);

    await expect(
      deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }), [], { linkFn }),
    ).rejects.toThrow(/EACCES|permission denied/);
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

    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({}), [{ source, target }, { source: source2, target: target2 }]);

    expect(await readFile(target, 'utf8')).toBe('# managed\r\n*ModA.esp\r\n');
    const manifest = parseManifest(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.loadOrder).toEqual([target, target2]);

    // target2 is already gone (e.g., manually removed) before purge runs — its rm(force:true)
    // must tolerate an already-absent path and not throw.
    await rm(target2, { force: true });

    await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);
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
    const loadOrder = [{ source, target }];

    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({}), loadOrder);
    // appdata/ now already exists — the second deploy's mkdir must tolerate that, not throw.
    const outcome = await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({}), loadOrder);

    expect(assertWrote(outcome)).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe('*ModA.esp\r\n');
  });

  it('skips and reports a winner whose Data/ path already exists and is not a prior link', async () => {
    fx = await makeDeployerFixture();
    await fx.writeDataFile('textures/foo.dds', 'VANILLA'); // pre-existing vanilla file
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'MODDED');

    const outcome = await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'textures/foo.dds': source }));

    // The vanilla file is untouched (not overwritten by the mod link).
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'), 'utf8')).toBe('VANILLA');
    const manifest = parseManifest(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual([]);
    // ADR-0019 integrity tier: this is mandatory, so a warning firing at all is what matters.
    expect(assertWrote(outcome).some((w) => w.detail?.includes('textures/foo.dds'))).toBe(true);
  });

  it('reports nothing when nothing was skipped, the load order wrote successfully, and both are on the same volume', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');

    const outcome = await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));

    // ADR-0019 rejects notification fatigue: nothing went wrong, so nothing should surface.
    expect(assertWrote(outcome)).toEqual([]);
  });

  it('re-running deploy after a reorder relinks only the changed winner, leaving others alone', async () => {
    fx = await makeDeployerFixture();
    const a1 = await fx.writeModFile('ModA', 'p.dds', 'A');
    const b1 = await fx.writeModFile('ModB', 'p.dds', 'B');
    const x = await fx.writeModFile('ModX', 'other.dds', 'X');

    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'p.dds': a1, 'other.dds': x }));

    const relinked: string[] = [];
    const spyLink = async (source: string, target: string) => { relinked.push(target); await link(source, target); };
    // Reorder: ModB now wins p.dds; other.dds is unchanged.
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'p.dds': b1, 'other.dds': x }), [], { linkFn: spyLink });

    expect(relinked).toEqual([join(fx.gameDirectory.dataFolder, 'p.dds')]);
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'p.dds'), 'utf8')).toBe('B');
  });

  it('re-deploy removes a link for a mod that disabling has dropped from the index', async () => {
    fx = await makeDeployerFixture();
    const a = await fx.writeModFile('ModA', 'a.esp', 'A');
    const b = await fx.writeModFile('ModB', 'b.esp', 'B');
    const c = await fx.writeModFile('ModC', 'c.esp', 'C');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'a.esp': a, 'b.esp': b, 'c.esp': c }));

    // c.esp's link is already gone from Data/ (e.g., manually removed) before the stale-link
    // cleanup runs — its rm(force:true) must tolerate this, not throw, and must not block
    // b.esp's (still-present) cleanup.
    await rm(join(fx.gameDirectory.dataFolder, 'c.esp'), { force: true });

    // ModB and ModC disabled: absent from the index.
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'a.esp': a }));

    await expect(stat(join(fx.gameDirectory.dataFolder, 'b.esp'))).rejects.toThrow();
    await expect(stat(join(fx.gameDirectory.dataFolder, 'c.esp'))).rejects.toThrow();
    const manifest = parseManifest(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['a.esp']);

    // Purge must not misfile the (already removed) b.esp/c.esp into overwrite/.
    await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);
    await expect(stat(join(fx.instanceRoot, 'overwrite', 'b.esp'))).rejects.toThrow();
    await expect(stat(join(fx.instanceRoot, 'overwrite', 'c.esp'))).rejects.toThrow();
  });

  // Proton/Wine resolves paths case-insensitively over case-sensitive ext4, so case-variant
  // paths are the same file to the game but different physical paths on disk.
  it('links exactly one file for a case-variant winner, at the winner\'s own casing', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'Textures/Foo.dds', 'A');

    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'Textures/Foo.dds': source }));

    await expect(stat(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'))).resolves.toBeTruthy();
    // The losing provider's own casing was never separately linked.
    await expect(stat(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).rejects.toThrow();
    const manifest = parseManifest(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['Textures/Foo.dds']);
  });

  it('removes the old-cased link and creates the new-cased one when the winner\'s casing changes on redeploy', async () => {
    fx = await makeDeployerFixture();
    const a = await fx.writeModFile('ModA', 'Textures/Foo.dds', 'A');
    const b = await fx.writeModFile('ModB', 'textures/foo.dds', 'B');

    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'Textures/Foo.dds': a }));
    await expect(stat(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'))).resolves.toBeTruthy();

    // Reorder: ModB now wins the same logical file, with a different casing.
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'textures/foo.dds': b }));

    // Old-cased target is gone — never orphaned in Data/.
    await expect(stat(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'))).rejects.toThrow();
    // New-cased target is present with the new winner's content.
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'), 'utf8')).toBe('B');

    const manifest = parseManifest(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['textures/foo.dds']); // never both casings
  });

  it('tolerates the old-cased link already being gone when the winner\'s casing changes on redeploy', async () => {
    fx = await makeDeployerFixture();
    const a = await fx.writeModFile('ModA', 'Textures/Foo.dds', 'A');
    const b = await fx.writeModFile('ModB', 'textures/foo.dds', 'B');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'Textures/Foo.dds': a }));

    // The old-cased target is already gone from Data/ (e.g., manually removed) before the
    // casing-change cleanup runs — its rm(force:true) must tolerate this, not throw.
    await rm(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'), { force: true });

    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'textures/foo.dds': b }));

    expect(await readFile(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'), 'utf8')).toBe('B');
  });

  it('purge after a casing change cleans up correctly, without misfiling into overwrite/', async () => {
    fx = await makeDeployerFixture();
    const a = await fx.writeModFile('ModA', 'Textures/Foo.dds', 'A');
    const b = await fx.writeModFile('ModB', 'textures/foo.dds', 'B');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'Textures/Foo.dds': a }));
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'textures/foo.dds': b }));

    await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);

    await expect(stat(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).rejects.toThrow();
    await expect(stat(join(fx.gameDirectory.dataFolder, 'Textures/Foo.dds'))).rejects.toThrow();
    // Nothing stray got moved into overwrite/ under either casing.
    await expect(stat(join(fx.instanceRoot, 'overwrite', 'textures/foo.dds'))).rejects.toThrow();
    await expect(stat(join(fx.instanceRoot, 'overwrite', 'Textures/Foo.dds'))).rejects.toThrow();
  });

  it('refuses (never re-snapshots Data/) when the manifest is corrupt', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));

    const target = join(fx.gameDirectory.dataFolder, 'mod.esp');
    const origStat = await stat(target);

    // Corrupt the manifest in place, as if a crash truncated the write.
    const manifestPath = join(fx.instanceRoot, ...MANIFEST);
    await writeFile(manifestPath, CORRUPT_MANIFEST);

    const source2 = await fx.writeModFile('ModB', 'other.esp', 'OTHER');
    const outcome = await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source, 'other.esp': source2 }));

    expect(assertRefused(outcome)).toMatch(/manifest/i);
    // Manifest on disk is untouched — not overwritten by a fresh snapshot.
    expect(await readFile(manifestPath, 'utf8')).toBe(CORRUPT_MANIFEST);
    // The original link from the first deploy is untouched (same inode).
    expect((await stat(target)).ino).toBe(origStat.ino);
    // Nothing from the second deploy's index got linked.
    await expect(stat(join(fx.gameDirectory.dataFolder, 'other.esp'))).rejects.toThrow();
  });

  it('refuses (as corrupt) when the manifest path is unreadable, not just when its content is invalid JSON', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    // A directory sitting where the manifest file should be: readFile fails with something
    // other than ENOENT (EISDIR) — the other half of "corrupt" besides unparseable content.
    await mkdir(join(fx.instanceRoot, ...MANIFEST), { recursive: true });

    const outcome = await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));

    expect(assertRefused(outcome)).toMatch(/manifest/i);
    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow();
  });

  it('refuses (as corrupt) when the manifest is valid JSON of the wrong shape, not just unparseable', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    // Well-formed JSON, but neither `links` nor `preExisting` — parseManifest's own check, not
    // JSON.parse's.
    await writeFile(join(fx.instanceRoot, ...MANIFEST), JSON.stringify({ notAManifest: true }));

    const outcome = await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));

    expect(assertRefused(outcome)).toMatch(/manifest/i);
    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow();
  });

  it('still writes the manifest (and warns) when a load-order source is missing, so links stay purgeable', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const loadOrder = [{
      source: join(fx.instanceRoot, 'profiles', 'Nope', 'plugins.txt'),
      target: join(fx.instanceRoot, 'appdata', 'plugins.txt'),
    }];

    const outcome = await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }), loadOrder);

    // The link and manifest exist despite the load-order copy failing.
    const manifest = parseManifest(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['mod.esp']);
    expect(manifest.loadOrder).toEqual([]);
    expect(assertWrote(outcome).length).toBeGreaterThan(0);

    // …and purge can therefore clean the link.
    await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);
    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow();
  });

  it('refuses hardlinking (never silently symlinks) when mods/ and the game dir are on different volumes', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const modsDir = join(fx.instanceRoot, 'mods');
    // Fake different device ids — a real second volume isn't guaranteed on CI.
    const statFn = (p: string) => Promise.resolve({ dev: p === modsDir ? 1 : 2, ino: 0 });

    const outcome = await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }), [], { statFn });

    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow(); // nothing linked
    await expect(stat(join(fx.instanceRoot, ...MANIFEST))).rejects.toThrow(); // no manifest written
    expect(assertRefused(outcome)).toMatch(/different drives/i);
  });
});

describe('manifestFile', () => {
  let fx: DeployerFixture | undefined;
  afterEach(() => fx?.cleanup());

  it('exists() is false before any deploy and true once a manifest exists', async () => {
    fx = await makeDeployerFixture();
    expect(await exists(manifestFile(fx.instanceRoot))).toBe(false);

    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({}));

    expect(await exists(manifestFile(fx.instanceRoot))).toBe(true);
  });
});

describe('purgeFromGameData', () => {
  let fx: DeployerFixture | undefined;
  afterEach(() => fx?.cleanup());

  it('reports a no-op, not a failure, when there is nothing to purge', async () => {
    fx = await makeDeployerFixture();

    const outcome = await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);

    expect(outcome).toEqual({ wrote: false });
  });

  it('deletes the manifested links only, leaving preExisting files untouched', async () => {
    fx = await makeDeployerFixture();
    await fx.writeDataFile('Fallout4.esm', 'VANILLA'); // preExisting
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    const source2 = await fx.writeModFile('ModB', 'mod2.esp', 'MOD2');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source, 'mod2.esp': source2 }));

    // mod2.esp's link is already gone from Data/ (e.g., manually removed) before purge runs —
    // its rm(force:true) must tolerate this, not throw.
    await rm(join(fx.gameDirectory.dataFolder, 'mod2.esp'), { force: true });

    await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);

    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow();
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'Fallout4.esm'), 'utf8')).toBe('VANILLA');
  });

  it('moves a stray Data/ file (neither link nor preExisting) into instanceRoot/overwrite/', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));
    // The game (or F4SE/MCM) writes a new file into Data/ while running.
    await fx.writeDataFile('F4SE/foo.log', 'GENERATED');

    const outcome = await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);

    // Moved out of Data/ into the instance's overwrite/ (sibling of mods/, not mods/overwrite/).
    await expect(stat(join(fx.gameDirectory.dataFolder, 'F4SE/foo.log'))).rejects.toThrow();
    expect(await readFile(join(fx.instanceRoot, 'overwrite', 'F4SE/foo.log'), 'utf8')).toBe('GENERATED');
    // The move succeeded — nothing to report.
    expect(assertWrote(outcome)).toEqual([]);
  });

  it('reports (does not silently drop) a stray Data/ file it could not move into overwrite/', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));
    await fx.writeDataFile('F4SE/foo.log', 'GENERATED');
    // Block the move target: a directory already occupies where the stray file would land.
    await mkdir(join(fx.instanceRoot, 'overwrite', 'F4SE', 'foo.log'), { recursive: true });

    const outcome = await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);

    // Reports the original rename failure directly — a non-EXDEV error must be rethrown, not
    // masked behind a second, different failure from wrongly attempting the copy+delete fallback.
    const warnings = assertWrote(outcome);
    expect(warnings.some((w) => w.detail?.includes('F4SE/foo.log') && w.detail.includes('rename'))).toBe(true);
    // Still in Data/ — purge did not silently lose it.
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'F4SE/foo.log'), 'utf8')).toBe('GENERATED');
  });

  it('falls back to copy+delete when a stray file\'s move fails with EXDEV (cross-volume overwrite/)', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));
    await fx.writeDataFile('F4SE/foo.log', 'GENERATED');
    const exdevError = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    const renameFn = () => Promise.reject(exdevError);

    const outcome = await purgeFromGameData(fx.instanceRoot, fx.gameDirectory, { renameFn });

    // Fell back to copy+delete: landed in overwrite/, gone from Data/.
    expect(await readFile(join(fx.instanceRoot, 'overwrite', 'F4SE/foo.log'), 'utf8')).toBe('GENERATED');
    await expect(stat(join(fx.gameDirectory.dataFolder, 'F4SE/foo.log'))).rejects.toThrow();
    // Succeeded via the fallback — nothing to report.
    expect(assertWrote(outcome)).toEqual([]);
  });

  it('prunes a now-empty Data/ directory but preserves one that still holds a preExisting file', async () => {
    fx = await makeDeployerFixture();
    await fx.writeDataFile('Meshes/vanilla.nif', 'VANILLA'); // preExisting, nested — Meshes/ must survive
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));
    // Stray, nested — Meshes/Stray/ must be pruned once emptied by the move.
    await fx.writeDataFile('Meshes/Stray/junk.tmp', 'GENERATED');

    await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);

    await expect(stat(join(fx.gameDirectory.dataFolder, 'Meshes/Stray'))).rejects.toThrow();
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'Meshes/vanilla.nif'), 'utf8')).toBe('VANILLA');
  });

  it('tolerates a manifest written before loadOrder tracking existed (no loadOrder field)', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));
    const manifestPath = join(fx.instanceRoot, ...MANIFEST);
    const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
    delete manifest.loadOrder;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const outcome = await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);

    expect(assertWrote(outcome)).toEqual([]);
    await expect(stat(join(fx.gameDirectory.dataFolder, 'mod.esp'))).rejects.toThrow();
  });

  it('refuses (never touches Data/ or deletes the manifest) when the manifest is corrupt', async () => {
    fx = await makeDeployerFixture();
    await fx.writeDataFile('Fallout4.esm', 'VANILLA'); // preExisting
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'mod.esp': source }));

    const manifestPath = join(fx.instanceRoot, ...MANIFEST);
    await writeFile(manifestPath, CORRUPT_MANIFEST);

    const outcome = await purgeFromGameData(fx.instanceRoot, fx.gameDirectory);

    expect(assertRefused(outcome)).toMatch(/manifest/i);
    // The linked file is still present — purge did not clean it up.
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'mod.esp'), 'utf8')).toBe('MOD');
    // The preExisting vanilla file is untouched.
    expect(await readFile(join(fx.gameDirectory.dataFolder, 'Fallout4.esm'), 'utf8')).toBe('VANILLA');
    // The corrupted manifest survives as evidence — not deleted.
    expect(await readFile(manifestPath, 'utf8')).toBe(CORRUPT_MANIFEST);
  });
});

describe('a deploy and a purge issued together', () => {
  let fx: DeployerFixture | undefined;
  afterEach(() => fx?.cleanup());

  // Rival: drop the shared lock. The purge would read the manifest the deploy is still
  // writing, and Data/'s live links would be snapshotted as the vanilla baseline.
  it('runs the purge after the deploy, never inside it', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');

    const [deployed, purged] = await Promise.all([
      deployToGameData(fx.instanceRoot, fx.gameDirectory, toLinks({ 'textures/foo.dds': source })),
      purgeFromGameData(fx.instanceRoot, fx.gameDirectory),
    ]);

    expect(assertWrote(deployed)).toEqual([]);
    expect(assertWrote(purged)).toEqual([]);
    await expect(stat(join(fx.instanceRoot, ...MANIFEST))).rejects.toThrow();
  });
});
