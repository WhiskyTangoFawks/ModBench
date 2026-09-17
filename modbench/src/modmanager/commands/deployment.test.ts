// The mechanics (hardlinking, the manifest, purge) are mo2FilesDeploy.test.ts's; this covers
// what the command decides: winners come from the value, not a walk; root/ never reaches
// Data/; and it refuses instead of throwing.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployMods, purgeMods } from './deployment';
import { makeDeployerFixture, makeIndex, type DeployerFixture } from '../test/deployerFixture';

const PROFILE = 'Default';
const MANIFEST = join('mods', '.medit-manifest.json');

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe('deployMods / purgeMods', () => {
  let fx: DeployerFixture | undefined;
  afterEach(() => fx?.cleanup());

  it('deploys the winners it is handed and reports that it wrote', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    const files = makeIndex({ 'textures/foo.dds': source }).files;

    const outcome = await deployMods(fx.instanceRoot, { activeProfile: PROFILE, files, gameDirectory: fx.gameDirectory });

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await exists(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).toBe(true);
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(true);
  });

  // Rival: rebuild the conflict index from modlist.txt instead of taking `files` as given. A
  // modlist.txt naming a mod absent from `files` proves the command never reads it.
  it('deploys exactly the winners handed in, never rebuilding from modlist.txt', async () => {
    fx = await makeDeployerFixture();
    const winner = await fx.writeModFile('ModB', 'textures/bar.dds', 'BARDATA');
    await mkdir(join(fx.instanceRoot, 'profiles', PROFILE), { recursive: true });
    await writeFile(join(fx.instanceRoot, 'profiles', PROFILE, 'modlist.txt'), '-ModB\n');
    const files = makeIndex({ 'textures/bar.dds': winner }).files;

    await deployMods(fx.instanceRoot, { activeProfile: PROFILE, files, gameDirectory: fx.gameDirectory });

    // modlist.txt disables ModB; a rebuild would deploy nothing. The handed-in `files` wins.
    expect(await exists(join(fx.gameDirectory.dataFolder, 'textures/bar.dds'))).toBe(true);
  });

  it('copies the load order to where the game reads it when a target is given', async () => {
    fx = await makeDeployerFixture();
    await mkdir(join(fx.instanceRoot, 'profiles', PROFILE), { recursive: true });
    await writeFile(join(fx.instanceRoot, 'profiles', PROFILE, 'plugins.txt'), '*Foo.esp\n');
    const target = join(fx.gameDirectory.root, 'plugins.txt');

    await deployMods(fx.instanceRoot, {
      activeProfile: PROFILE, files: makeIndex({}).files,
      gameDirectory: { ...fx.gameDirectory, loadOrderFile: target },
    });

    expect(await exists(target)).toBe(true);
  });

  it('skips a mod\'s root/ files — they map to the game root, not Data/', async () => {
    fx = await makeDeployerFixture();
    const dataFile = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDS');
    const rootFile = await fx.writeModFile('F4SE', 'root/f4se_loader.exe', 'EXE');
    const files = makeIndex({ 'textures/foo.dds': dataFile, 'root/f4se_loader.exe': rootFile }).files;

    await deployMods(fx.instanceRoot, { activeProfile: PROFILE, files, gameDirectory: fx.gameDirectory });

    await expect(stat(join(fx.gameDirectory.dataFolder, 'root/f4se_loader.exe'))).rejects.toThrow();
    expect(await exists(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).toBe(true);
  });

  it('deploys a mod file literally named "root" (no slash) normally into Data/root', async () => {
    fx = await makeDeployerFixture();
    const rootFile = await fx.writeModFile('ModA', 'root', 'ROOTFILE');
    const files = makeIndex({ root: rootFile }).files;

    await deployMods(fx.instanceRoot, { activeProfile: PROFILE, files, gameDirectory: fx.gameDirectory });

    expect(await exists(join(fx.gameDirectory.dataFolder, 'root'))).toBe(true);
  });

  // Rival: throw, or resolve applied with an unresolved game directory. Either way the caller
  // announces a deployment that never touched Data/.
  it('refuses without a game directory, and touches nothing', async () => {
    fx = await makeDeployerFixture();

    const outcome = await deployMods(fx.instanceRoot, { activeProfile: PROFILE, files: makeIndex({}).files, gameDirectory: undefined });

    expect(outcome).toMatchObject({ applied: false });
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
  });

  // Rival: report `wrote: true` unconditionally. A purge with nothing deployed would then
  // announce that it removed a deployment.
  it('purge reports it wrote nothing when there is no manifest', async () => {
    fx = await makeDeployerFixture();

    const outcome = await purgeMods(fx.instanceRoot, { gameDirectory: fx.gameDirectory });

    expect(outcome).toEqual({ applied: true, wrote: false });
  });

  it('purge removes the deployment a deploy just wrote', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    const files = makeIndex({ 'textures/foo.dds': source }).files;
    await deployMods(fx.instanceRoot, { activeProfile: PROFILE, files, gameDirectory: fx.gameDirectory });

    const outcome = await purgeMods(fx.instanceRoot, { gameDirectory: fx.gameDirectory });

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await exists(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).toBe(false);
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
  });

  // Rival: drop the shared queue the adapter serializes on. A purge issued alongside a deploy
  // would read the manifest mid-write, snapshotting Data/'s live links as the vanilla baseline.
  it('a purge issued during a deploy runs after it, never inside it', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    const files = makeIndex({ 'textures/foo.dds': source }).files;

    const [deployed, purged] = await Promise.all([
      deployMods(fx.instanceRoot, { activeProfile: PROFILE, files, gameDirectory: fx.gameDirectory }),
      purgeMods(fx.instanceRoot, { gameDirectory: fx.gameDirectory }),
    ]);

    expect(deployed).toEqual({ applied: true, wrote: true });
    expect(purged).toEqual({ applied: true, wrote: true });
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
  });
});
