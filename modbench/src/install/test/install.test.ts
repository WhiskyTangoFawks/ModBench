// An install is one rename, so the tests observe the effect on disk rather than the steps: what
// mods/ shows while the install runs, and which other files moved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { ARCHIVE_EXTENSIONS, defaultModName, installFromArchive, installFromFolder } from '../install';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import type { Runner } from '../extractArchive';
import { writeMetaIni } from '../../mo2Codecs/metaIni';
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
  // A trailing foreign line: not one of the owned keys `writeMetaIni` renders, so it proves an
  // upgrade's meta.ini write preserves what it does not own.
  const meta = writeMetaIni({ gameName: 'Fallout4', modid: '0', version: '1.0.0', installationFile: 'Old-1-0.7z' })
    + 'category="-1,"\n';
  await writeFile(join(modDir, 'meta.ini'), meta);
  return modDir;
}

function runnerFor(payloadRoot = 'Wrapper'): Runner {
  return async (_bin, args) => {
    const dest = present(args.find((a) => a.startsWith('-o')), "the runner's -o argument").slice(2);
    await writePayload(join(dest, payloadRoot));
  };
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

describe('install commands', () => {
  let root: string;
  let sourceFolder: string;

  beforeEach(async () => {
    root = await cloneCorpusFixture();
    sourceFolder = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
    await writePayload(sourceFolder);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sourceFolder, { recursive: true, force: true });
  });

  // Rival: populate mods/<name> in place with a recursive copy. The observer runs between that
  // copy's own awaits, so it sees the folder half-built and this fails.
  it('the mod folder is never observed partial — it appears whole or not at all', async () => {
    const observed: (string[] | null)[] = [];
    let observing = true;
    const stillObserving = () => observing;
    const observer = (async () => {
      while (stillObserving()) {
        observed.push(await treeOf(join(root, 'mods', MOD)));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const outcome = await installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME });
    observing = false;
    await observer;

    expect(outcome).toMatchObject({ applied: true });
    expect(observed.length).toBeGreaterThan(1); // the observer really did interleave
    expect(observed.filter((tree) => tree !== null)).not.toEqual([]); // and really did see it land
    for (const tree of observed) {
      if (tree !== null) expect(tree).toEqual(COMPLETE);
    }
  });

  // Rival: append the modlist line from the installer. The touch-set below has no modlist.txt
  // in it, so the snapshot comparison fails.
  it('writes the mod folder and nothing else — no modlist line, no download bookkeeping', async () => {
    const before = await snapshotTree(root);

    await installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME });

    const after = await snapshotTree(root);
    assertOnlyChanged(before, after, new Set(COMPLETE.map((p) => `mods/${MOD}/${p}`)));
  });

  it('the meta.ini carries the gameName it is handed, and an archive install its installationFile', async () => {
    const archive = join(root, 'downloads', 'Freshly-1-0.7z');
    const run: Runner = async (_bin, args) => {
      const dest = present(args.find((a) => a.startsWith('-o')), "the runner's -o argument").slice(2);
      await writePayload(join(dest, 'Wrapper'));
    };

    await installFromArchive(root, { kind: 'new', name: MOD }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run });

    const meta = await readFile(join(root, 'mods', MOD, 'meta.ini'), 'utf8');
    expect(meta).toContain('gameName=Fallout 4');
    expect(meta).toContain('installationFile=Freshly-1-0.7z');
    // The lone wrapper directory is peeled, so the payload lands at the mod root.
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  it('marks the download it landed from installed, in the sidecar beside it', async () => {
    const archive = join(root, 'downloads', 'Freshly-1-0.7z');

    const outcome = await installFromArchive(root, { kind: 'new', name: MOD }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toEqual({ applied: true, wrote: true, isFomod: false });
    expect(await readFile(`${archive}.meta`, 'utf8')).toContain('installed=true');
  });

  // Rival: mark by filename alone. A `.meta` would then appear in downloads/ for an archive the
  // user picked from their own Downloads folder, inventing a row for a file that is not there.
  it('writes no sidecar for an archive that is not a download', async () => {
    const archive = join(sourceFolder, 'Elsewhere-1-0.7z');

    await installFromArchive(root, { kind: 'new', name: MOD }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run: runnerFor() });

    expect(await treeOf(join(root, 'downloads'))).not.toContain('Elsewhere-1-0.7z.meta');
    await expect(readFile(`${archive}.meta`, 'utf8')).rejects.toThrow();
  });

  // The mod IS installed; only the bookkeeping failed, so the refusal rides beside `applied`.
  it('reports a failed mark beside the landed mod rather than as a refusal', async () => {
    const archive = join(root, 'downloads', 'Freshly-1-0.7z');
    await rm(join(root, 'downloads'), { recursive: true, force: true });
    await writeFile(join(root, 'downloads'), 'not a directory');

    const outcome = await installFromArchive(root, { kind: 'new', name: MOD }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toMatchObject({ applied: true, wrote: true });
    expect(outcome.applied && outcome.downloadRefusal).toMatch(/ENOTDIR|ENOENT/);
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  it('a new install writes the sidecar\'s version, same as it writes modid and installedFiles', async () => {
    const archive = join(root, 'downloads', 'Freshly-1-0.7z');

    await installFromArchive(root, { kind: 'new', name: MOD }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run: runnerFor(), modID: '111', fileID: '222', version: '3.0.0' });

    const meta = await readFile(join(root, 'mods', MOD, 'meta.ini'), 'utf8');
    expect(meta).toContain('version=3.0.0');
  });

  // Rival: catch EXDEV and fall back to a recursive copy. The mod folder would then exist, and
  // the applied assertion and the absence assertion both fail.
  it('refuses a cross-volume staging area instead of copying', async () => {
    const exdev = () => {
      const err: NodeJS.ErrnoException = new Error('EXDEV: cross-device link not permitted');
      err.code = 'EXDEV';
      return Promise.reject(err);
    };
    const before = await snapshotTree(root);

    const outcome = await installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME, renameFn: exdev });

    expect(await treeOf(join(root, 'mods', MOD))).toBeNull();
    assertOnlyChanged(before, await snapshotTree(root), new Set());
    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/different drives/);
  });

  it('leaves no staging directory behind, on success or on refusal', async () => {
    await installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME });
    await installFromFolder(root, { kind: 'new', name: 'Harder VATS' }, sourceFolder, { gameName: GAME_NAME });

    const leftovers = (await readdir(root)).filter((name) => name.startsWith('.medit-'));
    expect(leftovers).toEqual([]);
  });

  // Rival: restore the `exists(modDir)` branch that made an existing folder an upgrade. The
  // folder is then emptied and refilled, so both the refusal and the untouched-tree assertion
  // fail.
  it('refuses a new install onto an existing folder and leaves it untouched, even unlisted', async () => {
    const name = 'Unlisted Folder';
    const modDir = await makeExistingMod(root, name, false);
    const before = await treeOf(modDir);

    const outcome = await installFromFolder(root, { kind: 'new', name }, sourceFolder, { gameName: GAME_NAME });

    expect(outcome).toMatchObject({ applied: false });
    expect(!outcome.applied && outcome.refusal).toMatch(/already exists/);
    expect(await treeOf(modDir)).toEqual(before);
  });

  // Rival: fall back to landing a new mod when the folder is gone. The folder would then exist
  // and hold the payload, so both assertions fail.
  it('refuses an upgrade of a folder that is not under mods/, writing nothing', async () => {
    const before = await snapshotTree(root);

    const outcome = await installFromFolder(root, { kind: 'upgrade', name: 'Vanished Mod' }, sourceFolder, { gameName: GAME_NAME });

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

    const outcome = await installFromArchive(root, { kind: 'upgrade', name }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run: runnerFor(), modID: '111', fileID: '222' });

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

    const outcome = await installFromArchive(root, { kind: 'upgrade', name }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run: runnerFor() });

    expect(outcome).toMatchObject({ applied: true });
    expect(await treeOf(modDir)).toEqual(COMPLETE);
  });

  it('an upgrade with a sidecar version rewrites meta.ini\'s version', async () => {
    const name = 'Versioned Target'; // makeExistingMod's meta.ini starts at version=1.0.0
    const modDir = await makeExistingMod(root, name, false);
    const archive = join(root, 'downloads', 'Freshly-2-0.7z');

    await installFromArchive(root, { kind: 'upgrade', name }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run: runnerFor(), version: '2.0.0' });

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

    await installFromArchive(root, { kind: 'upgrade', name }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run: runnerFor() });

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
      const outcome = await installFromArchive(root, { kind: 'upgrade', name }, archive, join(root, 'downloads'), { gameName: GAME_NAME, run: runnerFor() });
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
      installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME }),
      installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME }),
    ]);

    expect(outcomes.filter((o) => o.applied)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.applied);
    expect(loser?.applied === false && loser.refusal).toMatch(/already exists/);
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  it('leaves the source folder where the user put it', async () => {
    await installFromFolder(root, { kind: 'new', name: MOD }, sourceFolder, { gameName: GAME_NAME });

    expect(await treeOf(sourceFolder)).toEqual(PAYLOAD.map((p) => p.split(sep).join('/')).sort());
  });

  it('reports a failed extraction as a refusal, not a throw', async () => {
    const run: Runner = () => Promise.reject(new Error('archive is corrupt'));

    const outcome = await installFromArchive(root, { kind: 'new', name: MOD }, join(root, 'downloads', 'bad.7z'), join(root, 'downloads'), { gameName: GAME_NAME, run });

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
