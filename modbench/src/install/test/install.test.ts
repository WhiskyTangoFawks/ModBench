import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { installCommands, type InstallAccess } from '../install';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { accessTo, readDownloadedFileMeta } from '../../test/mo2/adapterOver';
import { fakeArchiveReader } from '../../instanceAdapter/test/fakeArchiveReader';
import type { ArchiveReader } from '../../instanceAdapter/archiveReader';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';

const CORPUS_INI_GAME_NAME = 'Fallout 4';

const MOD = 'Freshly Installed Mod';

const PAYLOAD = [
  'Installed.esp',
  join('textures', 'added.dds'),
  join('meshes', 'deep', 'nested.nif'),
];

async function writePayload(root: string): Promise<void> {
  for (const relativePath of PAYLOAD) {
    await mkdir(join(root, relativePath, '..'), { recursive: true });
    await writeFile(join(root, relativePath), `bytes of ${relativePath}`);
  }
}

async function treeOf(dir: string): Promise<string[] | null> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const abs = join(at, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(relative(dir, abs).split(sep).join('/'));
    }
  };
  try {
    await walk(dir);
  } catch {
    return null;
  }
  return out.sort();
}

const COMPLETE = [...PAYLOAD.map((p) => p.split(sep).join('/')), 'meta.ini'].sort();

async function makeExistingMod(root: string, name: string): Promise<string> {
  const modDir = join(root, 'mods', name);
  await mkdir(modDir, { recursive: true });
  await writeFile(join(modDir, 'Stale.esp'), 'stale bytes');
  await writeFile(
    join(modDir, 'meta.ini'),
    '[General]\ngameName=Fallout4\nmodid=0\nversion=1.0.0\ninstallationFile=Old-1-0.7z\ncategory="-1,"\n',
  );
  return modDir;
}

const wrapped = (): ArchiveReader => fakeArchiveReader(PAYLOAD.map((p) => join('Wrapper', p)));

const withArchives = (access: InstallAccess, archives: Partial<ArchiveReader>): InstallAccess =>
  ({ ...access, archives: { ...access.archives, ...archives } });

async function pollUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('pollUntil: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const withAdapter = (access: InstallAccess, over: Partial<InstanceAdapter>): InstallAccess =>
  ({ ...access, adapter: { ...access.adapter, ...over } });

const errnoError = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${message}`), { code });

describe('install commands', () => {
  let root: string;
  let access: InstallAccess;
  let sourceFolder: string;

  async function downloadedFile(name: string): Promise<{ name: string; path: string }> {
    const path = join(root, 'downloads', name);
    await writeFile(path, 'archive bytes');
    return { name, path };
  }

  beforeEach(async () => {
    root = cloneCorpusFixture();
    access = { ...accessTo(root), archives: wrapped() };
    sourceFolder = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
    await writePayload(sourceFolder);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sourceFolder, { recursive: true, force: true });
  });

  it('writes nothing outside mods/<name> while it runs, from an archive or a folder', async () => {
    const FOLDER_MOD = 'Folder Installed Mod';
    const entriesAt = async (): Promise<string[]> =>
      [...await readdir(root), ...(await readdir(join(root, 'mods'))).map((name) => `mods/${name}`)];
    const before = new Set(await entriesAt());
    const seen = new Set<string>();
    let observing = true;
    const stillObserving = () => observing;
    const observer = (async () => {
      while (stillObserving()) {
        for (const path of await entriesAt()) {
          if (!before.has(path)) seen.add(path);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const slowly = withArchives(access, {
      extract: async (archivePath, destDir) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await access.archives.extract(archivePath, destDir);
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });

    const outcomes = [
      await installCommands(slowly).installFromArchive({ kind: 'new', name: MOD }, join(sourceFolder, 'a.7z'), { gameName: CORPUS_INI_GAME_NAME }),
      await installCommands(access).installFromFolder({ kind: 'new', name: FOLDER_MOD }, sourceFolder, { gameName: CORPUS_INI_GAME_NAME }),
    ];
    observing = false;
    await observer;

    expect(outcomes).toEqual([{ applied: true, wrote: true, isFomod: false }, { applied: true, wrote: true, isFomod: false }]);
    const observerInterleavedWithTheSlowInstall = seen.has(`mods/${MOD}`);
    expect(observerInterleavedWithTheSlowInstall).toBe(true);
    expect([...seen].filter((path) => path !== `mods/${MOD}` && path !== `mods/${FOLDER_MOD}`)).toEqual([]);
  });

  it('writes the mod folder and nothing else — no modlist line, no download bookkeeping', async () => {
    const before = await snapshotTree(root);

    await installCommands(access).installFromFolder({ kind: 'new', name: MOD }, sourceFolder, { gameName: CORPUS_INI_GAME_NAME });

    const after = await snapshotTree(root);
    assertOnlyChanged(before, after, new Set(COMPLETE.map((p) => `mods/${MOD}/${p}`)));
  });

  it('the meta.ini carries the gameName it is handed, and an archive install its archiveFilename, peeling the lone wrapper directory so the payload lands at the mod root', async () => {
    const archive = join(root, 'downloads', 'Freshly-1-0.7z');
    await installCommands(access).installFromArchive({ kind: 'new', name: MOD }, archive, { gameName: CORPUS_INI_GAME_NAME });

    const meta = await readFile(join(root, 'mods', MOD, 'meta.ini'), 'utf8');
    expect(meta).toContain('gameName=Fallout 4');
    expect(meta).toContain('installationFile=Freshly-1-0.7z');
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  const downloadMetaOf = (name: string) => readDownloadedFileMeta(root, name);

  it('marks the downloaded file it landed from installed', async () => {
    const file = await downloadedFile('Freshly-1-0.7z');

    const outcome = await installCommands(access).installFromArchive({ kind: 'new', name: MOD }, file.path, { gameName: CORPUS_INI_GAME_NAME });

    expect(outcome).toEqual({ applied: true, wrote: true, isFomod: false });
    expect(await downloadMetaOf(file.name)).toMatchObject({ status: 'Installed' });
  });

  it('marks no downloaded file for an archive that is not one, even one sharing its name', async () => {
    const file = await downloadedFile('Freshly-1-0.7z');
    const archive = join(sourceFolder, file.name);

    await installCommands(access).installFromArchive({ kind: 'new', name: MOD }, archive, { gameName: CORPUS_INI_GAME_NAME });

    expect(await downloadMetaOf(file.name)).toBeUndefined();
  });

  it('reports a failed mark beside the landed mod rather than as a refusal', async () => {
    const file = await downloadedFile('Freshly-1-0.7z');
    await mkdir(`${file.path}.meta`);

    const outcome = await installCommands(access).installFromArchive({ kind: 'new', name: MOD }, file.path, { gameName: CORPUS_INI_GAME_NAME });

    expect(outcome).toMatchObject({ applied: true, wrote: true });
    expect(outcome.applied && outcome.downloadRefusal).toMatch(/EISDIR/);
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  it('reports a downloaded file gone before its mark beside the landed mod, naming it', async () => {
    const file = { name: 'Freshly-1-0.7z', path: join(root, 'downloads', 'Freshly-1-0.7z') };

    const outcome = await installCommands(access).installFromArchive({ kind: 'new', name: MOD }, file.path, { gameName: CORPUS_INI_GAME_NAME });

    expect(outcome).toMatchObject({ applied: true, wrote: true });
    expect(outcome.applied && outcome.downloadRefusal).toContain('"Freshly-1-0.7z" is gone from disk');
  });

  it('a new install writes the sidecar\'s version, same as it writes modid and installedFiles', async () => {
    const archive = join(root, 'downloads', 'Freshly-1-0.7z');

    await installCommands(access).installFromArchive({ kind: 'new', name: MOD }, archive, { gameName: CORPUS_INI_GAME_NAME, modID: '111', fileID: '222', version: '3.0.0' });

    const meta = await readFile(join(root, 'mods', MOD, 'meta.ini'), 'utf8');
    expect(meta).toContain('version=3.0.0');
  });

  it('leaves nothing beside mods/ behind, on success or on refusal', async () => {
    const before = await readdir(root);

    await installCommands(access).installFromArchive({ kind: 'new', name: MOD }, join(sourceFolder, 'a.7z'), { gameName: CORPUS_INI_GAME_NAME });
    await installCommands(access).installFromFolder({ kind: 'new', name: 'Folder Installed Mod' }, sourceFolder, { gameName: CORPUS_INI_GAME_NAME });

    expect((await readdir(root)).sort()).toEqual(before.sort());
  });

  it('refuses a new install onto an existing folder and leaves it untouched, even unlisted', async () => {
    const name = 'Unlisted Folder';
    const modDir = await makeExistingMod(root, name);
    const before = await treeOf(modDir);

    const outcome = await installCommands(access).installFromFolder({ kind: 'new', name }, sourceFolder, { gameName: CORPUS_INI_GAME_NAME });

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/already exists/);
    expect(await treeOf(modDir)).toEqual(before);
  });

  it('refuses an upgrade of a folder that is not under mods/, writing nothing', async () => {
    const before = await snapshotTree(root);

    const outcome = await installCommands(access).installFromFolder({ kind: 'upgrade', name: 'Vanished Mod' }, sourceFolder, { gameName: CORPUS_INI_GAME_NAME });

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/no folder by that name/);
    expect(await treeOf(join(root, 'mods', 'Vanished Mod'))).toBeNull();
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  it('upgrades a target: the stale file goes, the release lands, meta.ini keeps owned keys, installedFiles and foreign keys', async () => {
    const name = 'Tracked Target';
    const modDir = await makeExistingMod(root, name);
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');

    const outcome = await installCommands(access).installFromArchive({ kind: 'upgrade', name }, archive, { gameName: CORPUS_INI_GAME_NAME, modID: '111', fileID: '222' });

    expect(outcome).toMatchObject({ applied: true });
    expect(await treeOf(modDir)).toEqual(COMPLETE);
    const meta = await readFile(join(modDir, 'meta.ini'), 'utf8');
    expect(meta).toContain('gameName=Fallout 4');
    expect(meta).toContain('modid=111');
    expect(meta).toContain('installationFile=Freshly-2-0.7z');
    expect(meta).toContain('1\\modid=111');
    expect(meta).toContain('1\\fileid=222');
    expect(meta).toContain('category="-1,"');
  });

  it('an upgrade that fails part way says so, naming the mod and what failed, and that nothing was rolled back, installing again being the recovery', async () => {
    const name = 'Untracked Target';
    await makeExistingMod(root, name);
    const failing = withAdapter(access, {
      extractUpgrade: async (mod) => ({
        ...(await access.adapter.extractUpgrade(mod)),
        land: () => Promise.reject(errnoError('EACCES', 'permission denied')),
      }),
    });

    const outcome = await installCommands(failing).installFromArchive({ kind: 'upgrade', name }, join(sourceFolder, 'a.7z'), { gameName: CORPUS_INI_GAME_NAME });

    expect(outcome).toEqual({
      applied: false,
      refusal: `Upgrading "${name}" failed partway and was not rolled back: EACCES: permission denied`,
    });
  });

  it('an upgrade with a sidecar version rewrites meta.ini\'s version', async () => {
    const name = 'Versioned Target';
    const modDir = await makeExistingMod(root, name);
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');

    await installCommands(access).installFromArchive({ kind: 'upgrade', name }, archive, { gameName: CORPUS_INI_GAME_NAME, version: '2.0.0' });

    const meta = await readFile(join(modDir, 'meta.ini'), 'utf8');
    expect(meta).toContain('version=2.0.0');
    expect(meta).not.toContain('version=1.0.0');
  });

  it('an upgrade with no sidecar version preserves whatever version the old meta.ini had, the version key being owned so an undefined must not clear it', async () => {
    const name = 'Unversioned Upgrade';
    const modDir = await makeExistingMod(root, name);
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');

    await installCommands(access).installFromArchive({ kind: 'upgrade', name }, archive, { gameName: CORPUS_INI_GAME_NAME });

    const meta = await readFile(join(modDir, 'meta.ini'), 'utf8');
    expect(meta).toContain('version=1.0.0');
  });

  it('a watcher armed on the target folder before an upgrade still fires for a write after it, polled as fs.watch\'s first callback can be a metadata touch rather than the write under test', async () => {
    const name = 'Watched Target';
    const modDir = await makeExistingMod(root, name);
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');
    let fired = false;
    const watcher = watch(modDir, () => { fired = true; });

    try {
      const outcome = await installCommands(access).installFromArchive({ kind: 'upgrade', name }, archive, { gameName: CORPUS_INI_GAME_NAME });
      expect(outcome).toMatchObject({ applied: true });

      fired = false;
      await writeFile(join(modDir, 'after-upgrade.txt'), 'x');
      await pollUntil(() => fired);
    } finally {
      watcher.close();
    }
  });

  it('serializes two new installs of one name — exactly one lands, the loser refuses as a collision rather than failing with a raw ENOTEMPTY', async () => {
    const outcomes = await Promise.all([
      installCommands(access).installFromFolder({ kind: 'new', name: MOD }, sourceFolder, { gameName: CORPUS_INI_GAME_NAME }),
      installCommands(access).installFromFolder({ kind: 'new', name: MOD }, sourceFolder, { gameName: CORPUS_INI_GAME_NAME }),
    ]);

    expect(outcomes.filter((o) => o.applied)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.applied);
    expect(loser?.applied === false && loser.refusal).toMatch(/already exists/);
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  it('leaves the source folder where the user put it', async () => {
    await installCommands(access).installFromFolder({ kind: 'new', name: MOD }, sourceFolder, { gameName: CORPUS_INI_GAME_NAME });

    expect(await treeOf(sourceFolder)).toEqual(PAYLOAD.map((p) => p.split(sep).join('/')).sort());
  });

  it('removes the folder of a new install that fails partway, and writes nothing else', async () => {
    const before = await snapshotTree(root);
    const dies = withArchives(access, {
      extract: async (archivePath, destDir) => {
        await access.archives.extract(archivePath, destDir);
        throw new Error('archive is truncated');
      },
    });

    const outcome = await installCommands(dies).installFromArchive({ kind: 'new', name: MOD }, join(sourceFolder, 'a.7z'), { gameName: CORPUS_INI_GAME_NAME });

    expect(!outcome.applied && outcome.refusal).toMatch(/truncated/);
    expect(await treeOf(join(root, 'mods', MOD))).toBeNull();
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  it('an upgrade whose extraction fails leaves the folder as it was, with the error shown', async () => {
    const name = 'Tracked Target';
    await makeExistingMod(root, name);
    const before = await snapshotTree(root);
    const dies = withArchives(access, {
      extract: async (archivePath, destDir) => {
        await access.archives.extract(archivePath, destDir);
        throw new Error('archive is truncated');
      },
    });

    const outcome = await installCommands(dies).installFromArchive({ kind: 'upgrade', name }, join(sourceFolder, 'a.7z'), { gameName: CORPUS_INI_GAME_NAME });

    expect(!outcome.applied && outcome.refusal).toMatch(/truncated/);
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  it('reports a failed extraction as a refusal, not a throw', async () => {
    const corrupt = withArchives(access, { extract: () => Promise.reject(new Error('archive is corrupt')) });

    const outcome = await installCommands(corrupt).installFromArchive({ kind: 'new', name: MOD }, join(root, 'downloads', 'bad.7z'), { gameName: CORPUS_INI_GAME_NAME });

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/corrupt/);
  });
});
