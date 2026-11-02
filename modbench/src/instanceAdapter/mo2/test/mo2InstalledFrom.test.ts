import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../../test/mo2/corpusFixture';
import type { InstalledPackage } from '../../instanceAdapter';

vi.mock('vscode', () => fakeVscodeModule());

const MOD = 'Unofficial Fallout 4 Patch';
const CARRIED = '[General]\ngameName=Fallout 4\nversion=1.0\ncategory="-1,"\n';

describe('writing a mod\'s metadata from its packages through the MO2 Instance adapter', () => {
  let root: string;
  const modFolder = (): string => join(root, 'mods', MOD);
  const meta = (): Promise<string> => readFile(join(modFolder(), 'meta.ini'), 'utf8');
  const download = async (name: string, hostMeta?: string): Promise<void> => {
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', name), 'bytes');
    if (hostMeta !== undefined) await writeFile(join(root, 'downloads', `${name}.meta`), hostMeta);
  };
  let inTrash: string[];
  const write = (...packages: (string | InstalledPackage)[]): Promise<void> => adapterOver(root).writeInstalledFrom(modFolder(), packages.map((one) => (typeof one === 'string' ? { name: one } : one)), async (path) => {
    inTrash.push(await readFile(path, 'utf8'));
    await rm(path);
  });

  beforeEach(async () => {
    root = cloneCorpusFixture();
    inTrash = [];
    await writeFile(join(modFolder(), 'meta.ini'), CARRIED);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('names the first package, and lists the Nexus mod and file of every package', async () => {
    await download('First.7z', '[General]\nmodID=111\nfileID=222\nversion=2.0\nfileCategory=3\n');
    await download('Second.7z', '[General]\nmodID=333\nfileID=444\n');

    await write({ name: 'First.7z', version: '2.0' }, 'Second.7z');

    const text = await meta();
    expect(text).toContain('installationFile=First.7z');
    expect(text).toContain('modid=111');
    expect(text).toContain('version=2.0');
    expect(text).toContain('nexusFileStatus=3');
    expect(text).toContain('1\\modid=111');
    expect(text).toContain('1\\fileid=222');
    expect(text).toContain('2\\modid=333');
    expect(text).toContain('2\\fileid=444');
    expect(text).toContain('size=2');
  });

  it.each([
    ['the newest of the packages', ['1.5', '2.0', '1.0'], 'version=2.0'],
    ['the only one a package names', [undefined, '1.5'], 'version=1.5'],
  ])('writes %s as the mod\'s version', async (_, versions, expected) => {
    await write(...versions.map((version, at) => ({ name: `P${at}.7z`, ...version === undefined ? {} : { version } })));

    expect(await meta()).toContain(expected);
  });

  it('keeps the version the mod carried when no package names one, and every key it does not own', async () => {
    await download('Bare.7z', '[General]\nversion=9.9\n');

    await write('Bare.7z');

    const text = await meta();
    expect(text).toContain('version=1.0');
    expect(text).toContain('category="-1,"');
    expect(text).toContain('installationFile=Bare.7z');
  });

  it('writes MO2\'s short name for the instance game into a mod that carries none', async () => {
    await writeFile(join(modFolder(), 'meta.ini'), '[General]\nversion=1.0\n');

    await write('Gone.7z');

    expect(await meta()).toContain('gameName=Fallout4\n');
  });

  it('names a package outside the downloads folder and records no host for it', async () => {
    await write('Gone.7z');

    const text = await meta();
    expect(text).toContain('installationFile=Gone.7z');
    expect(text).not.toContain('installedFiles');
  });

  it('takes the mod ID from the name of the package when its metadata holds none', async () => {
    await write('Release-1234-1-0.7z');

    expect(await meta()).toContain('modid=1234');
  });

  it('writes no mod ID for a downloaded file whose metadata and name hold none', async () => {
    await download('Bare.7z', '[General]\n');

    await write('Bare.7z');

    expect(await meta()).not.toContain('modid');
  });

  it.each([
    ['keeps the status the mod carried when the package knows none', '[General]\n', 'nexusFileStatus=3'],
    ['replaces it when the package knows one', '[General]\nfileCategory=5\n', 'nexusFileStatus=5'],
  ])('%s, and writes the key once', async (_, hostMeta, expected) => {
    await writeFile(join(modFolder(), 'meta.ini'), `${CARRIED}nexusFileStatus=3\n`);
    await download('Next.7z', hostMeta);

    await write('Next.7z');

    const text = await meta();
    expect(text).toContain(expected);
    expect(text.match(/nexusFileStatus=/g)).toHaveLength(1);
  });

  it('sends the metadata it replaces to the trash, and sends nothing when it changes nothing', async () => {
    await download('First.7z', '[General]\nmodID=111\nfileID=222\n');

    await write('First.7z');
    const afterFirst = [...inTrash];
    await write('First.7z');

    expect([afterFirst, inTrash]).toEqual([[CARRIED], [CARRIED]]);
  });
});
