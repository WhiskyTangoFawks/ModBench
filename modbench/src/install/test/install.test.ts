// The tests observe the effect on disk rather than the steps: what the instance shows while the
// install runs, and which files moved.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  ARCHIVE_EXTENSIONS, defaultModName, defaultModNameForFolder, installFromArchive, installFromFolder, isArchiveName,
  type InstallAccess,
} from '../install';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { accessTo, readDownloadedFileMeta } from '../../test/mo2/adapterOver';
import type { Runner } from '../extractArchive';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { present } from '../../ports/present';

// ModOrganizer.ini's own `gameName` in the corpus fixture, which the caller reads off the value.
const GAME_NAME = 'Fallout 4';

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

// Forward-slash relative paths of every file below `dir`, or null when it does not exist.
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

// A pre-existing target mod: an old plugin, a foreign meta.ini key, and (for the tracked case) a
// `.git` directory an upgrade must leave byte-identical.
async function makeExistingMod(root: string, name: string, tracked: boolean): Promise<string> {
  const modDir = join(root, 'mods', name);
  await mkdir(modDir, { recursive: true });
  if (tracked) {
    await mkdir(join(modDir, '.git'), { recursive: true });
    await writeFile(join(modDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }
  await writeFile(join(modDir, 'Stale.esp'), 'stale bytes');
  // `category` is a key install does not own, so it proves an upgrade keeps what it does not own.
  await writeFile(
    join(modDir, 'meta.ini'),
    '[General]\ngameName=Fallout4\nmodid=0\nversion=1.0.0\ninstallationFile=Old-1-0.7z\ncategory="-1,"\n',
  );
  return modDir;
}

function runnerFor(payloadRoot = 'Wrapper'): Runner {
  return async (_bin, args) => {
    const dest = present(args.find((a) => a.startsWith('-o')), "the runner's -o argument").slice(2);
    await writePayload(join(dest, payloadRoot));
  };
}

// ADR-0007 invariant 5: git on PATH is a product requirement. Isolated from the machine's own
// global/system config, so a host core.autocrlf or commit.gpgsign never reaches these commits.
const EMPTY_GLOBAL_GITCONFIG = join(mkdtempSync(join(tmpdir(), 'medit-git-config-')), 'gitconfig');
writeFileSync(EMPTY_GLOBAL_GITCONFIG, '');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_GLOBAL_GITCONFIG,
};
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV } });
}

// Polls rather than awaiting one event: fs.watch's first callback can be a metadata touch, not
// the write under test, so a single `once` risks resolving on the wrong event.
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The Instance adapter over the instance, with the members a test replaces.
const withAdapter = (access: InstallAccess, over: Partial<InstanceAdapter>): InstallAccess =>
  ({ ...access, adapter: { ...access.adapter, ...over } });

const errnoError = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${message}`), { code });

describe('install commands', () => {
  let root: string;
  let access: InstallAccess;
  let sourceFolder: string;

  // A downloaded file: its archive on disk in the downloads folder.
  async function downloadedFile(name: string): Promise<{ name: string; path: string }> {
    const path = join(root, 'downloads', name);
    await writeFile(path, 'archive bytes');
    return { name, path };
  }

  beforeEach(async () => {
    root = await cloneCorpusFixture();
    access = accessTo(root);
    sourceFolder = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
    await writePayload(sourceFolder);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sourceFolder, { recursive: true, force: true });
  });

  // Rival: extract into a staging folder beside mods/, as install once did. The observer sees
  // that folder appear in the instance, and this fails.
  it('writes nothing outside mods/<name> while it runs, from an archive or a folder', async () => {
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
    const slowly: Runner = async (bin, args) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await runnerFor()(bin, args);
      await new Promise((resolve) => setTimeout(resolve, 30));
    };

    await installFromArchive(access, { kind: 'new', name: MOD }, join(sourceFolder, 'a.7z'), { gameName: GAME_NAME, run: slowly });
    await installFromFolder(access, { kind: 'new', name: 'Harder VATS' }, sourceFolder, { gameName: GAME_NAME });
    observing = false;
    await observer;

    expect([...seen].sort()).toEqual(['mods/Harder VATS', `mods/${MOD}`]);
  });

  // Rival: append the modlist line from the installer. The touch-set below has no modlist.txt
  // in it, so the snapshot comparison fails.
  it('writes the mod folder and nothing else — no modlist line, no download bookkeeping', async () => {
    const before = await snapshotTree(root);

    await installFromFolder(access, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME });

    const after = await snapshotTree(root);
    assertOnlyChanged(before, after, new Set(COMPLETE.map((p) => `mods/${MOD}/${p}`)));
  });

  it('the meta.ini carries the gameName it is handed, and an archive install its installationFile', async () => {
    const archive = join(root, 'downloads', 'Freshly-1-0.7z');
    const run: Runner = async (_bin, args) => {
      const dest = present(args.find((a) => a.startsWith('-o')), "the runner's -o argument").slice(2);
      await writePayload(join(dest, 'Wrapper'));
    };

    await installFromArchive(access, { kind: 'new', name: MOD }, archive, { gameName: GAME_NAME, run });

    const meta = await readFile(join(root, 'mods', MOD, 'meta.ini'), 'utf8');
    expect(meta).toContain('gameName=Fallout 4');
    expect(meta).toContain('installationFile=Freshly-1-0.7z');
    // The lone wrapper directory is peeled, so the payload lands at the mod root.
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  const downloadMetaOf = (name: string) => readDownloadedFileMeta(root, name);

  it('marks the downloaded file it landed from installed', async () => {
    const file = await downloadedFile('Freshly-1-0.7z');

    const outcome = await installFromArchive(access, { kind: 'new', name: MOD }, file.path, { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toEqual({ applied: true, wrote: true, isFomod: false });
    expect(await downloadMetaOf(file.name)).toMatchObject({ status: 'Installed' });
  });

  // Rival: mark by filename alone. The downloads folder holds an archive of the same name, so a
  // mark would appear on a downloaded file the user never installed from.
  it('marks no downloaded file for an archive that is not one, even one sharing its name', async () => {
    const file = await downloadedFile('Freshly-1-0.7z');
    const archive = join(sourceFolder, file.name);

    await installFromArchive(access, { kind: 'new', name: MOD }, archive, { gameName: GAME_NAME, run: runnerFor() });

    expect(await downloadMetaOf(file.name)).toBeUndefined();
  });

  // The mod IS installed; only the bookkeeping failed, so the refusal rides beside `applied`.
  it('reports a failed mark beside the landed mod rather than as a refusal', async () => {
    const file = await downloadedFile('Freshly-1-0.7z');
    await mkdir(`${file.path}.meta`);

    const outcome = await installFromArchive(access, { kind: 'new', name: MOD }, file.path, { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toMatchObject({ applied: true, wrote: true });
    expect(outcome.applied && outcome.downloadRefusal).toMatch(/EISDIR/);
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  // Rival: read `gone` as marked. The value listed the file, but it left the disk before the mark.
  it('reports a downloaded file gone before its mark beside the landed mod, naming it', async () => {
    const file = { name: 'Freshly-1-0.7z', path: join(root, 'downloads', 'Freshly-1-0.7z') };

    const outcome = await installFromArchive(access, { kind: 'new', name: MOD }, file.path, { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toMatchObject({ applied: true, wrote: true });
    expect(outcome.applied && outcome.downloadRefusal).toContain('"Freshly-1-0.7z" is gone from disk');
  });

  it('a new install writes the sidecar\'s version, same as it writes modid and installedFiles', async () => {
    const archive = join(root, 'downloads', 'Freshly-1-0.7z');

    await installFromArchive(access, { kind: 'new', name: MOD }, archive, { gameName: GAME_NAME, run: runnerFor(), modID: '111', fileID: '222', version: '3.0.0' });

    const meta = await readFile(join(root, 'mods', MOD, 'meta.ini'), 'utf8');
    expect(meta).toContain('version=3.0.0');
  });

  // Rival: remove only the folder the mod root was detected in, which leaves the wrapper's parent.
  it('leaves nothing beside mods/ behind, on success or on refusal', async () => {
    const before = await readdir(root);

    await installFromArchive(access, { kind: 'new', name: MOD }, join(sourceFolder, 'a.7z'), { gameName: GAME_NAME, run: runnerFor() });
    await installFromFolder(access, { kind: 'new', name: 'Harder VATS' }, sourceFolder, { gameName: GAME_NAME });

    expect((await readdir(root)).sort()).toEqual(before.sort());
  });

  // Rival: restore the `exists(modDir)` branch that made an existing folder an upgrade. The
  // folder is then emptied and refilled, so both the refusal and the untouched-tree assertion
  // fail.
  it('refuses a new install onto an existing folder and leaves it untouched, even unlisted', async () => {
    const name = 'Unlisted Folder';
    const modDir = await makeExistingMod(root, name, false);
    const before = await treeOf(modDir);

    const outcome = await installFromFolder(access, { kind: 'new', name }, sourceFolder, { gameName: GAME_NAME });

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/already exists/);
    expect(await treeOf(modDir)).toEqual(before);
  });

  // Rival: fall back to landing a new mod when the folder is gone. The folder would then exist
  // and hold the payload, so both assertions fail.
  it('refuses an upgrade of a folder that is not under mods/, writing nothing', async () => {
    const before = await snapshotTree(root);

    const outcome = await installFromFolder(access, { kind: 'upgrade', name: 'Vanished Mod' }, sourceFolder, { gameName: GAME_NAME });

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/no folder by that name/);
    expect(await treeOf(join(root, 'mods', 'Vanished Mod'))).toBeNull();
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  it('upgrades a tracked target: .git survives byte-identical, the stale file goes, the release lands, meta.ini keeps owned keys, installedFiles and foreign keys', async () => {
    const name = 'Tracked Target';
    const modDir = await makeExistingMod(root, name, true);
    const oldGitHead = await readFile(join(modDir, '.git', 'HEAD'));
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');

    const outcome = await installFromArchive(access, { kind: 'upgrade', name }, archive, { gameName: GAME_NAME, run: runnerFor(), modID: '111', fileID: '222' });

    expect(outcome).toMatchObject({ applied: true });
    expect(await readFile(join(modDir, '.git', 'HEAD'))).toEqual(oldGitHead);
    expect(await treeOf(modDir)).toEqual([...COMPLETE, '.git/HEAD'].sort());
    const meta = await readFile(join(modDir, 'meta.ini'), 'utf8');
    expect(meta).toContain('gameName=Fallout 4'); // owned key, freshly written
    expect(meta).toContain('modid=111');
    expect(meta).toContain('installationFile=Freshly-2-0.7z');
    expect(meta).toContain('1\\modid=111');
    expect(meta).toContain('1\\fileid=222');
    expect(meta).toContain('category="-1,"'); // foreign key, untouched
  });

  it('upgrades an untracked target: the folder ends up holding only the release and meta.ini', async () => {
    const name = 'Untracked Target';
    const modDir = await makeExistingMod(root, name, false);
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');

    const outcome = await installFromArchive(access, { kind: 'upgrade', name }, archive, { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toMatchObject({ applied: true });
    expect(await treeOf(modDir)).toEqual(COMPLETE);
  });

  // Rival: keep `.git` alone, as an upgrade once did. The repository's ignore rules and the
  // plugin source would then go with the release they have nothing to do with.
  it('upgrades around the repository and the plugin source: .git, .gitignore and plugin-source/ survive', async () => {
    const name = 'Tracked Target';
    const modDir = await makeExistingMod(root, name, true);
    await writeFile(join(modDir, '.gitignore'), '*\n!plugin-source/\n');
    await mkdir(join(modDir, 'plugin-source', 'Tracked.esp'), { recursive: true });
    await writeFile(join(modDir, 'plugin-source', 'Tracked.esp', 'RecordData.json'), '{}');

    const outcome = await installFromArchive(access, { kind: 'upgrade', name }, join(sourceFolder, 'a.7z'), { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toMatchObject({ applied: true });
    expect(await treeOf(modDir)).toEqual(
      [...COMPLETE, '.git/HEAD', '.gitignore', 'plugin-source/Tracked.esp/RecordData.json'].sort(),
    );
    expect(await readFile(join(modDir, '.gitignore'), 'utf8')).toBe('*\n!plugin-source/\n');
  });

  it('an upgrade over a tracked mod keeps its repository rebasable: the edit branch rebases onto main cleanly, plugin source intact', async () => {
    const name = 'Tracked Target';
    const modDir = await makeExistingMod(root, name, false);
    const sourceFile = join(modDir, 'plugin-source', 'Tracked.esp', 'RecordData.json');
    await mkdir(join(modDir, 'plugin-source', 'Tracked.esp'), { recursive: true });
    await writeFile(sourceFile, '{"baseline":true}\n');
    await writeFile(join(modDir, '.gitignore'), 'meta.ini\n');
    git(modDir, ['init', '-b', 'main']);
    git(modDir, ['config', 'core.autocrlf', 'false']);
    git(modDir, ['config', 'commit.gpgsign', 'false']);
    git(modDir, ['add', '-A']);
    git(modDir, ['commit', '-m', 'Baseline']);
    git(modDir, ['checkout', '-b', 'edit']);
    await writeFile(sourceFile, '{"baseline":true,"edited":true}\n');
    git(modDir, ['commit', '-am', 'Edit a field']);
    git(modDir, ['checkout', 'main']);

    const outcome = await installFromArchive(access, { kind: 'upgrade', name }, join(sourceFolder, 'a.7z'), { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toMatchObject({ applied: true });
    git(modDir, ['add', '-A']);
    git(modDir, ['commit', '-m', 'Release 2.0']);
    git(modDir, ['checkout', 'edit']);

    expect(() => git(modDir, ['rebase', 'main'])).not.toThrow();

    expect(await readFile(sourceFile, 'utf8')).toBe('{"baseline":true,"edited":true}\n');
    expect(() => git(modDir, ['check-ignore', 'meta.ini'])).not.toThrow();
  });

  // Rival: refusing a release for holding a folder merely named "source". Skyrim SE's Creation Kit
  // ships script sources at a release's own root Source/ — ordinary content, not a collision.
  it('upgrades a release that ships a root Source folder, as ordinary content', async () => {
    const name = 'Untracked Target';
    const modDir = await makeExistingMod(root, name, false);
    const shipsSource: Runner = async (bin, args) => {
      await runnerFor()(bin, args);
      const dest = present(args.find((a) => a.startsWith('-o')), "the runner's -o argument").slice(2);
      await mkdir(join(dest, 'Wrapper', 'Source'));
      await writeFile(join(dest, 'Wrapper', 'Source', 'Script.psc'), '');
    };

    const outcome = await installFromArchive(access, { kind: 'upgrade', name }, join(sourceFolder, 'a.7z'), { gameName: GAME_NAME, run: shipsSource });

    expect(outcome).toMatchObject({ applied: true });
    expect(await treeOf(modDir)).toContain('Source/Script.psc');
  });

  // Rival: a case-sensitive match. Windows would move Plugin-Source/ onto the kept plugin-source/
  // part way; elsewhere it would land beside it and drop out of the mod's files.
  it.each(['.GITIGNORE', 'Plugin-Source'])(
    'refuses, before any write, a release that ships %s, naming it',
    async (entry) => {
      const name = 'Untracked Target';
      const modDir = await makeExistingMod(root, name, false);
      const before = await treeOf(modDir);
      const shipsRepositoryOrPluginSource: Runner = async (bin, args) => {
        await runnerFor()(bin, args);
        const dest = present(args.find((a) => a.startsWith('-o')), "the runner's -o argument").slice(2);
        await mkdir(join(dest, 'Wrapper', entry));
      };

      const outcome = await installFromArchive(access, { kind: 'upgrade', name }, join(sourceFolder, 'a.7z'), { gameName: GAME_NAME, run: shipsRepositoryOrPluginSource });

      expect(outcome).toEqual({
        applied: false,
        refusal: `Cannot upgrade "${name}": the release holds "${entry}", which is the mod's own repository or plugin source.`,
      });
      expect(await treeOf(modDir)).toEqual(before);
    },
  );

  // mods.md, What install does, story 5: installing again is the recovery, so nothing is undone.
  it('an upgrade that fails part way says so, naming the mod and what failed, and that nothing was rolled back', async () => {
    const name = 'Untracked Target';
    await makeExistingMod(root, name, false);
    const failing = withAdapter(access, {
      extractUpgrade: async (mod) => ({
        ...(await access.adapter.extractUpgrade(mod)),
        land: () => Promise.reject(errnoError('EACCES', 'permission denied')),
      }),
    });

    const outcome = await installFromArchive(failing, { kind: 'upgrade', name }, join(sourceFolder, 'a.7z'), { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toEqual({
      applied: false,
      refusal: `Upgrading "${name}" failed partway and was not rolled back: EACCES: permission denied`,
    });
  });

  it('an upgrade with a sidecar version rewrites meta.ini\'s version', async () => {
    const name = 'Versioned Target'; // makeExistingMod's meta.ini starts at version=1.0.0
    const modDir = await makeExistingMod(root, name, false);
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');

    await installFromArchive(access, { kind: 'upgrade', name }, archive, { gameName: GAME_NAME, run: runnerFor(), version: '2.0.0' });

    const meta = await readFile(join(modDir, 'meta.ini'), 'utf8');
    expect(meta).toContain('version=2.0.0');
    expect(meta).not.toContain('version=1.0.0');
  });

  // Rival: pass the identity's meta straight through without merging against the old text. The
  // version key is owned, so `undefined` there would clear it instead of leaving it as found.
  it('an upgrade with no sidecar version preserves whatever version the old meta.ini had', async () => {
    const name = 'Unversioned Upgrade'; // makeExistingMod's meta.ini starts at version=1.0.0
    const modDir = await makeExistingMod(root, name, false);
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');

    await installFromArchive(access, { kind: 'upgrade', name }, archive, { gameName: GAME_NAME, run: runnerFor() });

    const meta = await readFile(join(modDir, 'meta.ini'), 'utf8');
    expect(meta).toContain('version=1.0.0');
  });

  it('a watcher armed on the target folder before an upgrade still fires for a write after it', async () => {
    const name = 'Watched Target';
    const modDir = await makeExistingMod(root, name, true);
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');
    let fired = false;
    const watcher = watch(modDir, () => { fired = true; });

    try {
      const outcome = await installFromArchive(access, { kind: 'upgrade', name }, archive, { gameName: GAME_NAME, run: runnerFor() });
      expect(outcome).toMatchObject({ applied: true });

      fired = false;
      await writeFile(join(modDir, 'after-upgrade.txt'), 'x');
      await waitFor(() => fired);
    } finally {
      watcher.close();
    }
  });

  // Rival: drop the write lock. Both see the folder absent before either has written anything,
  // and the loser's rename onto the now-populated target fails with a raw ENOTEMPTY instead of
  // the collision refusal.
  it('serializes two new installs of one name — exactly one lands, the loser refuses as a collision', async () => {
    const outcomes = await Promise.all([
      installFromFolder(access, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME }),
      installFromFolder(access, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME }),
    ]);

    expect(outcomes.filter((o) => o.applied)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.applied);
    expect(loser?.applied === false && loser.refusal).toMatch(/already exists/);
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  it('leaves the source folder where the user put it', async () => {
    await installFromFolder(access, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME });

    expect(await treeOf(sourceFolder)).toEqual(PAYLOAD.map((p) => p.split(sep).join('/')).sort());
  });

  // Rival: report the failure and leave the folder, so the half-extracted mod shows up in mods/.
  it('removes the folder of a new install that fails partway, and writes nothing else', async () => {
    const before = await snapshotTree(root);
    const dies: Runner = async (bin, args) => {
      await runnerFor()(bin, args);
      throw new Error('archive is truncated');
    };

    const outcome = await installFromArchive(access, { kind: 'new', name: MOD }, join(sourceFolder, 'a.7z'), { gameName: GAME_NAME, run: dies });

    expect(!outcome.applied && outcome.refusal).toMatch(/truncated/);
    expect(await treeOf(join(root, 'mods', MOD))).toBeNull();
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  // Rival: clear the folder before extracting, so a failed extraction leaves it emptied.
  it('an upgrade whose extraction fails leaves the folder as it was, with the error shown', async () => {
    const name = 'Tracked Target';
    const modDir = await makeExistingMod(root, name, true);
    await mkdir(join(modDir, 'plugin-source'));
    await writeFile(join(modDir, 'plugin-source', 'RecordData.json'), '{}');
    const before = await snapshotTree(root);
    const dies: Runner = async (bin, args) => {
      await runnerFor()(bin, args);
      throw new Error('archive is truncated');
    };

    const outcome = await installFromArchive(access, { kind: 'upgrade', name }, join(sourceFolder, 'a.7z'), { gameName: GAME_NAME, run: dies });

    expect(!outcome.applied && outcome.refusal).toMatch(/truncated/);
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  it('reports a failed extraction as a refusal, not a throw', async () => {
    const run: Runner = () => Promise.reject(new Error('archive is corrupt'));

    const outcome = await installFromArchive(access, { kind: 'new', name: MOD }, join(root, 'downloads', 'bad.7z'), { gameName: GAME_NAME, run });

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/corrupt/);
  });
});

// Install's one export about which files it takes: every picker, and the Downloads view, reads
// this list rather than naming an extension of its own.
describe('ARCHIVE_EXTENSIONS', () => {
  it('is the archive extensions install can extract, lower-cased', () => {
    expect([...ARCHIVE_EXTENSIONS].sort()).toEqual(['7z', 'rar', 'zip']);
  });
});

describe('isArchiveName', () => {
  it('takes a name ending in an extension install can extract, case-insensitively', () => {
    expect(['a.zip', 'b.7z', 'c.RAR'].map(isArchiveName)).toEqual([true, true, true]);
  });

  it('refuses any other name', () => {
    expect(['notes.txt', 'a.zip.meta', 'zip'].map(isArchiveName)).toEqual([false, false, false]);
  });
});

describe('defaultModNameForFolder', () => {
  it("names a new mod after the folder it is installed from", () => {
    expect(defaultModNameForFolder(join('/somewhere', 'Sleep or Save'))).toBe('Sleep or Save');
  });
});

describe('defaultModName', () => {
  it('strips an archive extension install can extract', () => {
    expect(defaultModName('/downloads/Sleep or Save-123-1-0.zip')).toBe('Sleep or Save-123-1-0');
    expect(defaultModName('/downloads/Sleep or Save-123-1-0.7z')).toBe('Sleep or Save-123-1-0');
    expect(defaultModName('/downloads/Sleep or Save-123-1-0.rar')).toBe('Sleep or Save-123-1-0');
  });

  it('strips the extension case-insensitively', () => {
    expect(defaultModName('/downloads/Sleep or Save.ZIP')).toBe('Sleep or Save');
  });

  it('leaves a name with no recognised archive extension untouched', () => {
    expect(defaultModName('/downloads/notes.txt')).toBe('notes.txt');
  });
});
