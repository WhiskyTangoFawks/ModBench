import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { releaseRoot } from '../releaseRoot';

describe('where a release\'s files start', () => {
  let base: string;
  let extracted: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'release-root-'));
    extracted = join(base, 'extracted');
    await mkdir(extracted);
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  const holding = async (paths: readonly string[]): Promise<void> => {
    for (const path of paths) {
      await mkdir(dirname(join(extracted, path)), { recursive: true });
      await writeFile(join(extracted, path), '');
    }
  };

  it.each([
    ['a Data folder', ['Data/foo.esp', 'Data/meshes/x.nif'], { root: 'Data' }],
    ['files at the top', ['foo.esp', 'meshes/x.nif'], { root: '' }],
    ['a lone wrapper folder', ['MyMod-Main/foo.esp', 'MyMod-Main/textures/x.dds'], { root: 'MyMod-Main' }],
    ['a Data folder inside a wrapper', ['MyMod-Main/Data/foo.esp'], { root: 'MyMod-Main/Data' }],
    ['a Data folder beside a file', ['Data/foo.esp', 'readme.txt'], { root: 'Data' }],
    ['a wrapper beside a file', ['ModA/foo.esp', 'readme.txt'], { root: '' }],
    ['a FOMOD', ['fomod/ModuleConfig.xml', '00 Core/Data/foo.esp'], { root: '', fomod: 'xml' }],
    ['a FOMOD whose installer is a script', ['fomod/script.cs', '00 Core/foo.esp'], { root: '', fomod: 'script' }],
    ['a wrapped FOMOD, its config named in any case', ['MyMod/fomod/moduleconfig.xml', 'MyMod/00 Core/foo.esp'], { root: 'MyMod', fomod: 'xml' }],
    ['a folder named fomod with no config', ['fomod/readme.txt', '00 Core/Data/foo.esp'], { root: '' }],
    ['a lone top-level data folder, never a wrapper', ['meshes/x.nif'], { root: '' }],
    ['a lone top-level script extender folder, never a wrapper', ['F4SE/x.dll'], { root: '' }],
  ])('is %s', async (_, release, { root, ...fomod }) => {
    await holding(release);

    expect(await releaseRoot(extracted)).toEqual({ root: join(extracted, root), ...fomod });
  });

  it('peels no more than 32 wrapper folders', async () => {
    const levels = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
    await holding([`${levels.join('/')}/foo.esp`]);

    expect(await releaseRoot(extracted)).toEqual({ root: join(extracted, ...levels.slice(0, 32)) });
  });

  it('takes a link to a Data folder for the Data folder', async () => {
    await mkdir(join(base, 'real'), { recursive: true });
    await symlink(join(base, 'real'), join(extracted, 'Data'));

    expect(await releaseRoot(extracted)).toEqual({ root: join(extracted, 'Data') });
  });

  it('takes a link to a module config file for a FOMOD', async () => {
    await mkdir(join(extracted, 'fomod'));
    await writeFile(join(base, 'config.xml'), '');
    await symlink(join(base, 'config.xml'), join(extracted, 'fomod', 'ModuleConfig.xml'));

    expect(await releaseRoot(extracted)).toEqual({ root: extracted, fomod: 'xml' });
  });

  it('does not unwrap a lone folder when a link to a file sits beside it', async () => {
    await mkdir(join(extracted, 'Wrapper'));
    await writeFile(join(base, 'readme.txt'), '');
    await symlink(join(base, 'readme.txt'), join(extracted, 'readme.txt'));

    expect(await releaseRoot(extracted)).toEqual({ root: extracted });
  });
});
