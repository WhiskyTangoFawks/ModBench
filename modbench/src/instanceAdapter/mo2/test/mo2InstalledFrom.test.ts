import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../../test/mo2/corpusFixture';

vi.mock('vscode', () => fakeVscodeModule());

const MOD = 'Unofficial Fallout 4 Patch';

describe('writing a mod\'s metadata from its packages through the MO2 Instance adapter', () => {
  let root: string;
  const modFolder = (): string => join(root, 'mods', MOD);
  const meta = (): Promise<string> => readFile(join(modFolder(), 'meta.ini'), 'utf8');
  const download = async (name: string, hostMeta?: string): Promise<void> => {
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', name), 'bytes');
    if (hostMeta !== undefined) await writeFile(join(root, 'downloads', `${name}.meta`), hostMeta);
  };
  const write = (...packages: string[]): Promise<void> => adapterOver(root).writeInstalledFrom(modFolder(), packages, (path) => rm(path));

  beforeEach(async () => {
    root = cloneCorpusFixture();
    await writeFile(join(modFolder(), 'meta.ini'), '[General]\ngameName=Fallout 4\nversion=1.0\ncategory="-1,"\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('names the first package, and lists the Nexus mod and file of every package', async () => {
    await download('First.7z', '[General]\nmodID=111\nfileID=222\nversion=2.0\nfileCategory=3\n');
    await download('Second.7z', '[General]\nmodID=333\nfileID=444\n');

    await write('First.7z', 'Second.7z');

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

  it('keeps each value the packages do not know, and every key it does not own', async () => {
    await download('Bare.7z', '[General]\n');

    await write('Bare.7z');

    const text = await meta();
    expect(text).toContain('version=1.0');
    expect(text).toContain('category="-1,"');
    expect(text).toContain('installationFile=Bare.7z');
  });

  it('names a package outside the downloads folder and records no host for it', async () => {
    await write('Gone.7z');

    const text = await meta();
    expect(text).toContain('installationFile=Gone.7z');
    expect(text).not.toContain('installedFiles');
  });

  it('writes nothing, and trashes nothing, when the metadata is already what the packages say', async () => {
    await download('First.7z', '[General]\nmodID=111\nfileID=222\n');
    await write('First.7z');
    const trashed: string[] = [];

    await adapterOver(root).writeInstalledFrom(modFolder(), ['First.7z'], (path) => { trashed.push(path); return Promise.resolve(); });

    expect(trashed).toEqual([]);
  });
});
