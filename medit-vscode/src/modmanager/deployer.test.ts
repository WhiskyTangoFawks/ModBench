import { describe, it, expect, afterEach } from 'vitest';
import { link, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deploy, purge } from './deployer';
import { makeDeployerFixture, makeIndex, type DeployerFixture } from './test/deployerFixture';

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
    const index = makeIndex({});

    await deploy(fx.instanceRoot, fx.gameDirectory, index, fakeReporter(), {
      loadOrder: [{ source, target }],
    });

    expect(await readFile(target, 'utf8')).toBe('# managed\r\n*ModA.esp\r\n');
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.loadOrder).toEqual([target]);

    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());
    await expect(stat(target)).rejects.toThrow();
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
    expect(reporter.reports.some((r) => r.detail?.includes('textures/foo.dds'))).toBe(true);
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
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'a.esp': a, 'b.esp': b }), fakeReporter());

    // ModB disabled → no longer in the index.
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'a.esp': a }), fakeReporter());

    await expect(stat(join(fx.gameDirectory.dataFolder, 'b.esp'))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(fx.instanceRoot, ...MANIFEST), 'utf8'));
    expect(manifest.links).toEqual(['a.esp']);

    // Purge must not misfile the (already removed) b.esp into overwrite/.
    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());
    await expect(stat(join(fx.instanceRoot, 'overwrite', 'b.esp'))).rejects.toThrow();
  });

  it('purge deletes the manifested links only, leaving preExisting files untouched', async () => {
    fx = await makeDeployerFixture();
    await fx.writeDataFile('Fallout4.esm', 'VANILLA'); // preExisting
    const source = await fx.writeModFile('ModA', 'mod.esp', 'MOD');
    await deploy(fx.instanceRoot, fx.gameDirectory, makeIndex({ 'mod.esp': source }), fakeReporter());

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

    await purge(fx.instanceRoot, fx.gameDirectory, fakeReporter());

    // Moved out of Data/ into the instance's overwrite/ (sibling of mods/, not mods/overwrite/).
    await expect(stat(join(fx.gameDirectory.dataFolder, 'F4SE/foo.log'))).rejects.toThrow();
    expect(await readFile(join(fx.instanceRoot, 'overwrite', 'F4SE/foo.log'), 'utf8')).toBe('GENERATED');
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
});
