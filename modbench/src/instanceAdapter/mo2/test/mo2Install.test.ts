import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { watch, type PathLike } from 'node:fs';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { present } from '../../../ports/present';

vi.mock('vscode', () => fakeVscodeModule());
const real = vi.hoisted(() => ({ rename: undefined as typeof import('node:fs/promises').rename | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  real.rename = actual.rename;
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualRename = (from: PathLike, to: PathLike): Promise<void> => present(real.rename, 'the real rename')(from, to);

import { mkdir, mkdtemp, readdir, readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchiveReader, InstanceAdapter, InstallPackage } from '../../instanceAdapter';
import { SCRIPT_EXTENDER_FOLDERS } from '../../../tables/gamePaths';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../../test/mo2/corpusFixture';
import { fakeArchiveReader } from '../../../test/fakeArchiveReader';

const MOD = 'New Mod';
const UPGRADED = 'Unofficial Fallout 4 Patch';
const DOWNLOAD = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
const PAYLOAD = ['Installed.esp', 'textures/added.dds', 'meshes/deep/nested.nif'];
const ARCHIVE: InstallPackage = { kind: 'archive', path: '/elsewhere/Release-1-0.7z' };
const KEYS = {};

const errnoError = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${message}`), { code });

async function filesIn(folder: string): Promise<string[] | null> {
  const files = [...(await snapshotTree(folder)).keys()].sort();
  return files.length === 0 ? null : files;
}

describe('installing a mod through the MO2 Instance adapter', () => {
  let root: string;
  const folder = (mod: string): string => join(root, 'mods', mod);
  const meta = (mod: string): Promise<string> => readFile(join(folder(mod), 'meta.ini'), 'utf8');
  const holding = (files: readonly string[], over: Partial<ArchiveReader> = {}): InstanceAdapter =>
    adapterOver(root, { archives: { ...fakeArchiveReader(files), ...over } });

  beforeEach(() => {
    root = cloneCorpusFixture();
  });
  afterEach(async () => {
    vi.mocked(fsRename).mockImplementation(actualRename);
    await rm(root, { recursive: true, force: true });
  });

  describe('a new mod', () => {
    it('puts an archive\'s files into a new folder and writes nothing else, its meta holding only the keys it is given', async () => {
      const before = await snapshotTree(root);

      const outcome = await holding([...PAYLOAD, 'meta.ini']).install(ARCHIVE, { kind: 'new', name: MOD }, { ...KEYS, archiveFilename: 'Release-1-0.7z' });

      expect(outcome).toEqual({ landed: true, isFomod: false });
      expect(await filesIn(folder(MOD))).toEqual([...PAYLOAD, 'meta.ini'].sort());
      expect(await meta(MOD)).toBe('[General]\ngameName=Fallout 4\ninstallationFile=Release-1-0.7z\n');
      assertOnlyChanged(before, await snapshotTree(root), new Set([...PAYLOAD, 'meta.ini'].map((file) => `mods/${MOD}/${file}`)));
    });

    it('records the file it was installed from as a pair with the mod\'s Nexus id', async () => {
      await holding([...PAYLOAD, 'meta.ini']).install(ARCHIVE, { kind: 'new', name: MOD }, { nexusId: '111', installedFileKeys: ['111:222'] });

      expect(await meta(MOD)).toBe('[General]\ngameName=Fallout 4\nmodid=111\n[installedFiles]\n1\\modid=111\n1\\fileid=222\nsize=1\n');
    });

    it('copies a folder\'s files in, leaving the folder where the user put it', async () => {
      const source = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
      try {
        await mkdir(join(source, 'textures'));
        await writeFile(join(source, 'Copied.esp'), 'plugin');
        await writeFile(join(source, 'textures', 'a.dds'), 'texture');
        const before = await snapshotTree(root);

        await holding([]).install({ kind: 'folder', path: source }, { kind: 'new', name: MOD }, KEYS);

        expect(await filesIn(folder(MOD))).toEqual(['Copied.esp', 'meta.ini', 'textures/a.dds']);
        assertOnlyChanged(before, await snapshotTree(root), new Set(['Copied.esp', 'meta.ini', 'textures/a.dds'].map((file) => `mods/${MOD}/${file}`)));
        expect(await filesIn(source)).toEqual(['Copied.esp', 'textures/a.dds']);
      } finally {
        await rm(source, { recursive: true, force: true });
      }
    });

    it('lands nothing and writes nothing for a mod a folder already holds, matched as MO2 matches names, listed or not', async () => {
      await mkdir(folder('Unlisted Folder'));
      await writeFile(join(folder('Unlisted Folder'), 'Kept.esp'), '');
      const before = await snapshotTree(root);

      const outcomes = [
        await holding(PAYLOAD).install(ARCHIVE, { kind: 'new', name: 'unlisted folder' }, KEYS),
        await holding(PAYLOAD).install(ARCHIVE, { kind: 'new', name: 'harder vats' }, KEYS),
      ];

      expect(outcomes).toEqual([{ landed: false }, { landed: false }]);
      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('lands one of two installs of one name at once, and the other finds the folder there', async () => {
      const adapter = holding(PAYLOAD);

      const outcomes = await Promise.all([
        adapter.install(ARCHIVE, { kind: 'new', name: MOD }, KEYS),
        adapter.install(ARCHIVE, { kind: 'new', name: MOD }, KEYS),
      ]);

      expect(outcomes).toEqual(expect.arrayContaining([{ landed: true, isFomod: false }, { landed: false }]));
      expect(await filesIn(folder(MOD))).toEqual([...PAYLOAD, 'meta.ini'].sort());
    });

    it('rejects with why, and takes its folder with it, when the extraction fails partway', async () => {
      const before = await snapshotTree(root);
      const dies = holding(PAYLOAD, {
        extract: async (archivePath, destDir) => {
          await fakeArchiveReader(PAYLOAD).extract(archivePath, destDir);
          throw new Error('archive is truncated');
        },
      });

      await expect(dies.install(ARCHIVE, { kind: 'new', name: MOD }, KEYS)).rejects.toThrow('archive is truncated');

      expect(await readdir(join(root, 'mods'))).not.toContain(MOD);
      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('writes nothing beside its own folder while it runs', async () => {
      const entries = async (): Promise<string[]> => [...await readdir(root), ...(await readdir(join(root, 'mods'))).map((name) => `mods/${name}`)];
      const before = new Set(await entries());
      const seen = new Set<string>();
      const slowly = holding(PAYLOAD, {
        extract: async (archivePath, destDir) => {
          for (const path of await entries()) seen.add(path);
          await fakeArchiveReader(PAYLOAD).extract(archivePath, destDir);
          for (const path of await entries()) seen.add(path);
        },
      });

      await slowly.install(ARCHIVE, { kind: 'new', name: MOD }, KEYS);

      expect([...seen].filter((path) => !before.has(path))).toEqual([`mods/${MOD}`]);
      expect([...await entries()].filter((path) => !before.has(path))).toEqual([`mods/${MOD}`]);
    });
  });

  describe('the root it chooses inside the release, and whether the release is a scripted installer', () => {
    it.each([
      ['a Data folder', ['Data/foo.esp', 'Data/meshes/x.nif'], ['foo.esp', 'meshes/x.nif'], false],
      ['files at the top', ['foo.esp', 'meshes/x.nif'], ['foo.esp', 'meshes/x.nif'], false],
      ['a lone wrapper folder', ['MyMod-Main/foo.esp', 'MyMod-Main/textures/x.dds'], ['foo.esp', 'textures/x.dds'], false],
      ['a Data folder inside a wrapper', ['MyMod-Main/Data/foo.esp'], ['foo.esp'], false],
      ['a Data folder beside a file', ['Data/foo.esp', 'readme.txt'], ['foo.esp'], false],
      ['a wrapper beside a file', ['ModA/foo.esp', 'readme.txt'], ['ModA/foo.esp', 'readme.txt'], false],
      ['a FOMOD', ['fomod/ModuleConfig.xml', '00 Core/Data/foo.esp'], ['00 Core/Data/foo.esp', 'fomod/ModuleConfig.xml'], true],
      ['a wrapped FOMOD, its config named in any case', ['MyMod/fomod/moduleconfig.xml', 'MyMod/00 Core/foo.esp'], ['00 Core/foo.esp', 'fomod/moduleconfig.xml'], true],
      ['a FOMOD with more than its config', ['MyMod/fomod/ModuleConfig.xml', 'MyMod/fomod/info.xml', 'MyMod/00 Core/foo.esp'], ['00 Core/foo.esp', 'fomod/ModuleConfig.xml', 'fomod/info.xml'], true],
      ['a folder named fomod with no config', ['fomod/readme.txt', '00 Core/Data/foo.esp'], ['00 Core/Data/foo.esp', 'fomod/readme.txt'], false],
    ])('%s', async (_, release, landed, isFomod) => {
      const outcome = await holding(release).install(ARCHIVE, { kind: 'new', name: MOD }, KEYS);

      expect(outcome).toEqual({ landed: true, isFomod });
      expect(await filesIn(folder(MOD))).toEqual([...landed, 'meta.ini'].sort());
    });

    it.each([
      ...SCRIPT_EXTENDER_FOLDERS, 'meshes',
      'textures', 'materials', 'sound', 'music', 'scripts', 'source', 'interface', 'strings', 'mcm', 'seq', 'video', 'vis',
      'lodsettings', 'shadersfx', 'grass', 'terrain', 'planetdata', 'programs', 'scaleform', 'facegen', 'actors', 'distantlod',
    ])('keeps a lone top-level data folder %s, never taking it for a wrapper', async (name) => {
      await holding([`${name}/x.dat`]).install(ARCHIVE, { kind: 'new', name: MOD }, KEYS);

      expect(await filesIn(folder(MOD))).toEqual([`${name}/x.dat`, 'meta.ini'].sort());
    });

    it('peels no more than 32 wrapper folders', async () => {
      const levels = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);

      await holding([`${levels.join('/')}/foo.esp`]).install(ARCHIVE, { kind: 'new', name: MOD }, KEYS);

      expect(await filesIn(folder(MOD))).toEqual([`${levels.slice(32).join('/')}/foo.esp`, 'meta.ini'].sort());
    });
  });

  describe('an upgrade', () => {
    beforeEach(async () => {
      await writeFile(join(folder(UPGRADED), '.gitignore'), 'shipped');
      await writeFile(join(folder(UPGRADED), 'Old.esp'), '');
      await mkdir(join(folder(UPGRADED), 'plugin-source', 'shipped'), { recursive: true });
      await writeFile(join(folder(UPGRADED), 'plugin-source', 'shipped', 'Old.json'), '');
    });

    it('replaces the folder\'s files other than its manifest, and leaves the mod\'s repository beside mods/ as it was', async () => {
      const repository = join(root, 'source', UPGRADED);
      await mkdir(join(repository, '.git'), { recursive: true });
      await writeFile(join(repository, '.git', 'HEAD'), 'ref');
      const before = await snapshotTree(repository);

      const outcome = await holding(['New.esp']).install(ARCHIVE, { kind: 'upgrade', name: 'unofficial fallout 4 patch' }, KEYS);

      expect(outcome).toEqual({ landed: true, isFomod: false });
      expect(await filesIn(folder(UPGRADED))).toEqual(['New.esp', 'meta.ini']);
      expect(await snapshotTree(repository)).toEqual(before);
    });

    it('keeps the mod\'s manifest, which the release does not replace', async () => {
      const manifest = `${UPGRADED}.manifest.json`;
      await writeFile(join(folder(UPGRADED), manifest), '{"kept":true}');

      await holding(['New.esp']).install(ARCHIVE, { kind: 'upgrade', name: UPGRADED }, KEYS);

      expect(await readFile(join(folder(UPGRADED), manifest), 'utf8')).toBe('{"kept":true}');
    });

    it('unwraps a release nested in a wrapper folder', async () => {
      const outcome = await holding(['Wrapper/Nested.esp']).install(ARCHIVE, { kind: 'upgrade', name: UPGRADED }, KEYS);

      expect(outcome).toEqual({ landed: true, isFomod: false });
      expect(await filesIn(folder(UPGRADED))).toEqual(['Nested.esp', 'meta.ini']);
    });

    it('lands a release holding .git, .gitignore and plugin-source as any content', async () => {
      await holding(['.git/HEAD', '.gitignore', 'plugin-source/released.json']).install(ARCHIVE, { kind: 'upgrade', name: UPGRADED }, KEYS);

      expect(await filesIn(folder(UPGRADED))).toEqual(['.git/HEAD', '.gitignore', 'meta.ini', 'plugin-source/released.json']);
    });

    it('sets the keys it is given over the meta the mod had, keeping each value they leave out, and never over a meta the release ships', async () => {
      await holding(['meta.ini']).install(ARCHIVE, { kind: 'upgrade', name: UPGRADED }, { version: '2.2' });

      expect(await meta(UPGRADED)).toBe(
        `[General]\r\ngameName=Fallout 4\r\nmodid=4598\r\nversion=2.2\r\ncategory="-1,"\r\ninstallationFile=${DOWNLOAD}\r\n`,
      );
    });

    it('lands nothing and writes nothing for a mod no folder holds', async () => {
      const before = await snapshotTree(root);

      const outcome = await holding(PAYLOAD).install(ARCHIVE, { kind: 'upgrade', name: 'Vanished Mod' }, KEYS);

      expect(outcome).toEqual({ landed: false });
      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('leaves the folder as it was when the extraction fails', async () => {
      const before = await snapshotTree(root);
      const dies = holding(PAYLOAD, {
        extract: async (archivePath, destDir) => {
          await fakeArchiveReader(PAYLOAD).extract(archivePath, destDir);
          throw new Error('archive is truncated');
        },
      });

      await expect(dies.install(ARCHIVE, { kind: 'upgrade', name: UPGRADED }, KEYS)).rejects.toThrow('archive is truncated');

      assertOnlyChanged(before, await snapshotTree(root), new Set());
    });

    it('says when it fails part way, naming the mod and what failed, and that nothing was rolled back', async () => {
      vi.mocked(fsRename).mockRejectedValueOnce(errnoError('EACCES', 'permission denied'));

      await expect(holding(PAYLOAD).install(ARCHIVE, { kind: 'upgrade', name: UPGRADED }, KEYS)).rejects.toThrow(
        `Upgrading "${UPGRADED}" failed partway and was not rolled back: EACCES: permission denied`,
      );
    });

    it('keeps the folder itself, so a watcher armed on it still hears a write after the upgrade', async () => {
      const heard: string[] = [];
      const watcher = watch(folder(UPGRADED), (_, name) => { if (name !== null) heard.push(name); });
      try {
        await holding(PAYLOAD).install(ARCHIVE, { kind: 'upgrade', name: UPGRADED }, KEYS);

        await writeFile(join(folder(UPGRADED), 'after-upgrade.txt'), 'x');
        await vi.waitFor(() => expect(heard).toContain('after-upgrade.txt'));
      } finally {
        watcher.close();
      }
    });
  });
});
