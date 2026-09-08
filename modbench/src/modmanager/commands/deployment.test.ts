// The deployer itself is covered by deployer.test.ts; these cover what the command adds — it
// walks disk for its own modlist, refuses instead of throwing, and reports whether it wrote.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployMods, purgeMods } from './deployment';
import { makeDeployerFixture, type DeployerFixture } from '../test/deployerFixture';

const PROFILE = 'Default';
const MANIFEST = join('mods', '.medit-manifest.json');

function fakeReporter() {
  const reports: { severity: string; message: string; detail?: string }[] = [];
  return { reports, report: (severity: string, message: string, detail?: string) => reports.push({ severity, message, detail }) };
}

async function writeModlist(instanceRoot: string, text: string): Promise<void> {
  const dir = join(instanceRoot, 'profiles', PROFILE);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'modlist.txt'), text);
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe('deployMods / purgeMods', () => {
  let fx: DeployerFixture | undefined;
  afterEach(() => fx?.cleanup());

  it('deploys the profile\'s own modlist and reports that it wrote', async () => {
    fx = await makeDeployerFixture();
    await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    await writeModlist(fx.instanceRoot, '+ModA\n');

    const outcome = await deployMods(
      fx.instanceRoot, PROFILE, fx.gameDirectory, undefined, fakeReporter(), () => {});

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await exists(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).toBe(true);
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(true);
  });

  it('leaves a disabled mod out — the modlist read is the command\'s own, not a caller\'s', async () => {
    fx = await makeDeployerFixture();
    await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    await writeModlist(fx.instanceRoot, '-ModA\n');

    await deployMods(fx.instanceRoot, PROFILE, fx.gameDirectory, undefined, fakeReporter(), () => {});

    expect(await exists(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).toBe(false);
  });

  it('copies the load order to where the game reads it when a target is given', async () => {
    fx = await makeDeployerFixture();
    await writeModlist(fx.instanceRoot, '');
    await writeFile(join(fx.instanceRoot, 'profiles', PROFILE, 'plugins.txt'), '*Foo.esp\n');
    const target = join(fx.gameDirectory.root, 'plugins.txt');

    await deployMods(fx.instanceRoot, PROFILE, fx.gameDirectory, target, fakeReporter(), () => {});

    expect(await exists(target)).toBe(true);
  });

  // Rival: throw, or resolve applied with an unresolved game directory. Either way the caller
  // announces a deployment that never touched Data/.
  it('refuses without a game directory, and touches nothing', async () => {
    fx = await makeDeployerFixture();
    await writeModlist(fx.instanceRoot, '+ModA\n');

    const outcome = await deployMods(fx.instanceRoot, PROFILE, undefined, undefined, fakeReporter(), () => {});

    expect(outcome).toMatchObject({ applied: false });
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
  });

  it('refuses rather than throwing when the profile has no modlist', async () => {
    fx = await makeDeployerFixture();

    const outcome = await deployMods(fx.instanceRoot, PROFILE, fx.gameDirectory, undefined, fakeReporter(), () => {});

    expect(outcome).toMatchObject({ applied: false });
    expect(outcome.applied === false && outcome.refusal).toMatch(/ENOENT/);
  });

  // Rival: report `wrote: true` unconditionally. A purge with nothing deployed would then
  // announce that it removed a deployment.
  it('purge reports it wrote nothing when there is no manifest', async () => {
    fx = await makeDeployerFixture();

    const outcome = await purgeMods(fx.instanceRoot, fx.gameDirectory, fakeReporter());

    expect(outcome).toEqual({ applied: true, wrote: false });
  });

  it('purge removes the deployment a deploy just wrote', async () => {
    fx = await makeDeployerFixture();
    await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    await writeModlist(fx.instanceRoot, '+ModA\n');
    await deployMods(fx.instanceRoot, PROFILE, fx.gameDirectory, undefined, fakeReporter(), () => {});

    const outcome = await purgeMods(fx.instanceRoot, fx.gameDirectory, fakeReporter());

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(await exists(join(fx.gameDirectory.dataFolder, 'textures/foo.dds'))).toBe(false);
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
  });

  // Rival: drop the shared queue. The purge would read the manifest the deploy is still
  // writing, and Data/'s live links would be snapshotted as the vanilla baseline.
  it('a purge issued during a deploy runs after it, never inside it', async () => {
    fx = await makeDeployerFixture();
    await fx.writeModFile('ModA', 'textures/foo.dds', 'DDSDATA');
    await writeModlist(fx.instanceRoot, '+ModA\n');

    const [deployed, purged] = await Promise.all([
      deployMods(fx.instanceRoot, PROFILE, fx.gameDirectory, undefined, fakeReporter(), () => {}),
      purgeMods(fx.instanceRoot, fx.gameDirectory, fakeReporter()),
    ]);

    expect(deployed).toEqual({ applied: true, wrote: true });
    expect(purged).toEqual({ applied: true, wrote: true });
    expect(await exists(join(fx.instanceRoot, MANIFEST))).toBe(false);
  });
});
