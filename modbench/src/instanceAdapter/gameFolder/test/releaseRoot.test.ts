import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { FomodAnswer, InstallPackage, InstanceAdapter } from '../../instanceAdapter';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';
import { instanceOnDisk } from '../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const MOD = 'New Mod';
const ARCHIVE: InstallPackage = { kind: 'archive', path: '/elsewhere/Release-1-0.7z' };
const MANUAL: FomodAnswer = { kind: 'manual' };
const trash = (path: string): Promise<void> => rm(path, { recursive: true, force: true });
const INSTALLER = { xml: /no choices were given for its steps/, script: /its installer is a script/ };

describe('where a release\'s files start, as an install lands them', () => {
  let instance: string;
  let base: string;

  beforeEach(async () => {
    instance = await instanceOnDisk();
    base = await mkdtemp(join(tmpdir(), 'release-root-'));
  });
  afterEach(async () => {
    await rm(instance, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  const landed = async (): Promise<string[]> => {
    const folder = join(instance, 'mods', MOD);
    const entries = await readdir(folder, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => !entry.isDirectory()).map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'))
      .filter((path) => path !== 'meta.ini').sort();
  };
  const holding = (release: readonly string[]): InstanceAdapter => adapterOver(instance, { installationFileReader: fakeInstallationFileReader(release) });
  const extracted = async (): Promise<{ readonly folder: InstallPackage; readonly at: string }> => {
    const at = join(base, 'extracted');
    await mkdir(at);
    return { folder: { kind: 'folder', path: at }, at };
  };

  it.each([
    ['a Data folder', ['Data/foo.esp', 'Data/meshes/x.nif'], ['foo.esp', 'meshes/x.nif']],
    ['files at the top', ['foo.esp', 'meshes/x.nif'], ['foo.esp', 'meshes/x.nif']],
    ['a lone wrapper folder', ['MyMod-Main/foo.esp', 'MyMod-Main/textures/x.dds'], ['foo.esp', 'textures/x.dds']],
    ['a Data folder inside a wrapper', ['MyMod-Main/Data/foo.esp'], ['foo.esp']],
    ['a Data folder beside a file', ['Data/foo.esp', 'readme.txt'], ['foo.esp']],
    ['a wrapper beside a file', ['ModA/foo.esp', 'readme.txt'], ['ModA/foo.esp', 'readme.txt']],
    ['a folder named fomod with no config', ['fomod/readme.txt', '00 Core/Data/foo.esp'], ['00 Core/Data/foo.esp', 'fomod/readme.txt']],
    ['a lone top-level data folder, never a wrapper', ['meshes/x.nif'], ['meshes/x.nif']],
    ['a lone top-level script extender folder, never a wrapper', ['F4SE/x.dll'], ['F4SE/x.dll']],
  ])('is %s', async (_, release, files) => {
    expect(await holding(release).install(ARCHIVE, { kind: 'new', name: MOD }, trash)).toEqual({ landed: true });
    expect(await landed()).toEqual(files);
  });

  it.each([
    ['a FOMOD', 'xml', ['fomod/ModuleConfig.xml', '00 Core/Data/foo.esp'], ['00 Core/Data/foo.esp', 'fomod/ModuleConfig.xml']],
    ['a FOMOD whose installer is a script', 'script', ['fomod/script.cs', '00 Core/foo.esp'], ['00 Core/foo.esp', 'fomod/script.cs']],
    ['a wrapped FOMOD, its config named in any case', 'xml', ['MyMod/fomod/moduleconfig.xml', 'MyMod/00 Core/foo.esp'], ['00 Core/foo.esp', 'fomod/moduleconfig.xml']],
  ] as const)('is %s, beside its installer', async (_, installer, release, files) => {
    await expect(holding(release).install(ARCHIVE, { kind: 'new', name: MOD }, trash)).rejects.toThrow(INSTALLER[installer]);
    expect(await holding(release).install(ARCHIVE, { kind: 'new', name: MOD }, trash, MANUAL)).toMatchObject({ landed: true });
    expect(await landed()).toEqual(files);
  });

  it('peels no more than 32 wrapper folders', async () => {
    const levels = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);

    await holding([`${levels.join('/')}/foo.esp`]).install(ARCHIVE, { kind: 'new', name: MOD }, trash);

    expect(await landed()).toEqual([`${levels.slice(32).join('/')}/foo.esp`]);
  });

  it('takes a link to a Data folder for the Data folder', async () => {
    const { folder, at } = await extracted();
    await mkdir(join(base, 'real'));
    await writeFile(join(base, 'real', 'foo.esp'), '');
    await symlink(join(base, 'real'), join(at, 'Data'));

    await holding([]).install(folder, { kind: 'new', name: MOD }, trash);

    expect(await landed()).toEqual(['foo.esp']);
  });

  it('takes a link to a module config file for a FOMOD', async () => {
    const { folder, at } = await extracted();
    await mkdir(join(at, 'fomod'));
    await writeFile(join(base, 'config.xml'), '');
    await symlink(join(base, 'config.xml'), join(at, 'fomod', 'ModuleConfig.xml'));

    await expect(holding([]).install(folder, { kind: 'new', name: MOD }, trash)).rejects.toThrow(INSTALLER.xml);
  });

  it('does not unwrap a lone folder when a link to a file sits beside it', async () => {
    const { folder, at } = await extracted();
    await mkdir(join(at, 'Wrapper'));
    await writeFile(join(at, 'Wrapper', 'foo.esp'), '');
    await writeFile(join(base, 'readme.txt'), '');
    await symlink(join(base, 'readme.txt'), join(at, 'readme.txt'));

    await holding([]).install(folder, { kind: 'new', name: MOD }, trash);

    expect(await landed()).toEqual(['Wrapper/foo.esp', 'readme.txt']);
  });
});
