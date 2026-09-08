// An install is one rename, so the tests observe the effect on disk rather than the steps: what
// mods/ shows while the install runs, and which other files moved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { installFromArchive, installFromFolder } from './install';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../test/corpusFixture';
import type { Runner } from '../install/extractArchive';

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

    const outcome = await installFromFolder(root, MOD, sourceFolder);
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

    await installFromFolder(root, MOD, sourceFolder);

    const after = await snapshotTree(root);
    assertOnlyChanged(before, after, new Set(COMPLETE.map((p) => `mods/${MOD}/${p}`)));
  });

  it('the meta.ini carries the instance gameName, and an archive install its installationFile', async () => {
    const archive = join(root, 'downloads', 'Freshly-1-0.7z');
    const run: Runner = async (_bin, args) => {
      const dest = args.find((a) => a.startsWith('-o'))!.slice(2);
      await writePayload(join(dest, 'Wrapper'));
    };

    await installFromArchive(root, MOD, archive, { run });

    const meta = await readFile(join(root, 'mods', MOD, 'meta.ini'), 'utf8');
    expect(meta).toContain('gameName=Fallout 4');
    expect(meta).toContain('installationFile=Freshly-1-0.7z');
    // The lone wrapper directory is peeled, so the payload lands at the mod root.
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
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

    const outcome = await installFromFolder(root, MOD, sourceFolder, { renameFn: exdev });

    expect(await treeOf(join(root, 'mods', MOD))).toBeNull();
    assertOnlyChanged(before, await snapshotTree(root), new Set());
    expect(outcome).toMatchObject({ applied: false });
    expect(outcome.applied === false && outcome.refusal).toMatch(/different drives/);
  });

  it('leaves no staging directory behind, on success or on refusal', async () => {
    await installFromFolder(root, MOD, sourceFolder);
    await installFromFolder(root, 'Harder VATS', sourceFolder);

    const leftovers = (await readdir(root)).filter((name) => name.startsWith('.medit-'));
    expect(leftovers).toEqual([]);
  });

  it('refuses a name already taken by a mod folder, touching nothing', async () => {
    const before = await snapshotTree(root);

    const outcome = await installFromFolder(root, 'Harder VATS', sourceFolder);

    expect(outcome).toMatchObject({ applied: false });
    expect(outcome.applied === false && outcome.refusal).toMatch(/already exists/);
    assertOnlyChanged(before, await snapshotTree(root), new Set());
  });

  // Rival: drop the write lock. Both pass the collision check, and the loser's rename fails
  // with a raw ENOTEMPTY instead of the name-already-taken refusal.
  it('serializes two installs of one name — one lands, the other is refused by name', async () => {
    const [first, second] = await Promise.all([
      installFromFolder(root, MOD, sourceFolder),
      installFromFolder(root, MOD, sourceFolder),
    ]);

    const refusals = [first, second].filter((o) => !o.applied);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].refusal).toMatch(/already exists/);
    expect(await treeOf(join(root, 'mods', MOD))).toEqual(COMPLETE);
  });

  it('leaves the source folder where the user put it', async () => {
    await installFromFolder(root, MOD, sourceFolder);

    expect(await treeOf(sourceFolder)).toEqual(PAYLOAD.map((p) => p.split(sep).join('/')).sort());
  });

  it('reports a failed extraction as a refusal, not a throw', async () => {
    const run: Runner = () => Promise.reject(new Error('archive is corrupt'));

    const outcome = await installFromArchive(root, MOD, join(root, 'downloads', 'bad.7z'), { run });

    expect(outcome).toMatchObject({ applied: false });
    expect(outcome.applied === false && outcome.refusal).toMatch(/corrupt/);
  });
});
