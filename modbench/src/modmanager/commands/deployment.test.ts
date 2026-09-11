// The deployer itself is covered by deployer.test.ts; this covers what the command adds — winners
// come from the caller, not a walk; refuses instead of throwing; and asks once before a first
// deploy into a manifest-less directory.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployMods, purgeMods, DEPLOY_CONFIRM_BUTTON } from './deployment';
import { makeDeployerFixture, makeIndex, type DeployerFixture } from '../test/deployerFixture';
import { recordingReporter } from '../../test/surfacingDoubles';

const PROFILE = 'Default';
const MANIFEST = join('mods', '.medit-manifest.json');

// Never asked: used by every test whose fixture already has a manifest, or that predates the
// prompt existing — a call here is itself a failure of "asks only on an absent manifest".
const neverAsk = () => { throw new Error('showWarning should not have been called'); };
const accept = vi.fn().mockResolvedValue(DEPLOY_CONFIRM_BUTTON);
const decline = vi.fn().mockResolvedValue(undefined);

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe('deployMods / purgeMods', () => {
  let fx: DeployerFixture | undefined;
  afterEach(() => fx?.cleanup());

  it('deploys the winners it is handed and reports that it wrote', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    const files = makeIndex({ 'textures/foo.dds': source }).files;

    const outcome = await deployMods(
      fx.instanceRoot, PROFILE, files, fx.gameDirectory, undefined, recordingReporter(), accept);

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

    await deployMods(fx.instanceRoot, PROFILE, files, fx.gameDirectory, undefined, recordingReporter(), accept);

    // modlist.txt disables ModB; a rebuild would deploy nothing. The handed-in `files` wins.
    expect(await exists(join(fx.gameDirectory.dataFolder, 'textures/bar.dds'))).toBe(true);
  });

  it('copies the load order to where the game reads it when a target is given', async () => {
    fx = await makeDeployerFixture();
    await mkdir(join(fx.instanceRoot, 'profiles', PROFILE), { recursive: true });
    await writeFile(join(fx.instanceRoot, 'profiles', PROFILE, 'plugins.txt'), '*Foo.esp\n');
    const target = join(fx.gameDirectory.root, 'plugins.txt');

    await deployMods(fx.instanceRoot, PROFILE, makeIndex({}).files, fx.gameDirectory, target, recordingReporter(), accept);

    expect(await exists(target)).toBe(true);
  });

  // Rival: throw, or resolve applied with an unresolved game directory. Either way the caller
  // announces a deployment that never touched Data/.
  it('refuses without a game directory, and touches nothing', async () => {
    fx = await makeDeployerFixture();

    const outcome = await deployMods(
      fx.instanceRoot, PROFILE, makeIndex({}).files, undefined, undefined, recordingReporter(), neverAsk);

    expect(outcome).toMatchObject({ applied: false });
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
  });

  // Rival: deploy without asking. Accepting deploys and writes the manifest; declining refuses
  // and touches nothing — proven against the same fixture so only the answer differs.
  describe('first deploy into a directory with no manifest', () => {
    it('asks once, and accepting deploys and writes the manifest', async () => {
      fx = await makeDeployerFixture();
      const source = await fx.writeModFile('ModA', 'a.esp', 'BYTES');
      const files = makeIndex({ 'a.esp': source }).files;
      const showWarning = vi.fn().mockResolvedValue(DEPLOY_CONFIRM_BUTTON);

      const outcome = await deployMods(
        fx.instanceRoot, PROFILE, files, fx.gameDirectory, undefined, recordingReporter(), showWarning);

      expect(showWarning).toHaveBeenCalledOnce();
      expect(outcome).toEqual({ applied: true, wrote: true });
      expect(await exists(join(fx.gameDirectory.dataFolder, 'a.esp'))).toBe(true);
      expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(true);
    });

    it('declining refuses and writes nothing', async () => {
      fx = await makeDeployerFixture();
      const source = await fx.writeModFile('ModA', 'a.esp', 'BYTES');
      const files = makeIndex({ 'a.esp': source }).files;

      const outcome = await deployMods(
        fx.instanceRoot, PROFILE, files, fx.gameDirectory, undefined, recordingReporter(), decline);

      expect(outcome).toMatchObject({ applied: false });
      expect(await exists(join(fx.gameDirectory.dataFolder, 'a.esp'))).toBe(false);
      expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
    });
  });

  // Rival: ask unconditionally. A second deploy against a manifest the first one just wrote must
  // never raise the prompt.
  it('a directory that already has a manifest does not ask', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'a.esp', 'BYTES');
    const files = makeIndex({ 'a.esp': source }).files;
    await deployMods(fx.instanceRoot, PROFILE, files, fx.gameDirectory, undefined, recordingReporter(), accept);

    const outcome = await deployMods(
      fx.instanceRoot, PROFILE, files, fx.gameDirectory, undefined, recordingReporter(), neverAsk);

    expect(outcome).toEqual({ applied: true, wrote: true });
  });

  // Rival: report `wrote: true` unconditionally. A purge with nothing deployed would then
  // announce that it removed a deployment.
  it('purge reports it wrote nothing when there is no manifest', async () => {
    fx = await makeDeployerFixture();

    const outcome = await purgeMods(fx.instanceRoot, fx.gameDirectory, recordingReporter());

    expect(outcome).toEqual({ applied: true, wrote: false });
  });

  it('purge removes the deployment a deploy just wrote', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    const files = makeIndex({ 'textures/foo.dds': source }).files;
    await deployMods(fx.instanceRoot, PROFILE, files, fx.gameDirectory, undefined, recordingReporter(), accept);

    const outcome = await purgeMods(fx.instanceRoot, fx.gameDirectory, recordingReporter());

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await exists(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).toBe(false);
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
  });

  // Rival: drop the shared queue. The purge would read the manifest the deploy is still
  // writing, and Data/'s live links would be snapshotted as the vanilla baseline.
  it('a purge issued during a deploy runs after it, never inside it', async () => {
    fx = await makeDeployerFixture();
    const source = await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    const files = makeIndex({ 'textures/foo.dds': source }).files;

    const [deployed, purged] = await Promise.all([
      deployMods(fx.instanceRoot, PROFILE, files, fx.gameDirectory, undefined, recordingReporter(), accept),
      purgeMods(fx.instanceRoot, fx.gameDirectory, recordingReporter()),
    ]);

    expect(deployed).toEqual({ applied: true, wrote: true });
    expect(purged).toEqual({ applied: true, wrote: true });
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
  });
});
