// #41 corpus — the hardlink deploy/purge pipeline against the committed
// mo2-instance-corpus fixture, driven end-to-end: read the real modlist, build the
// real FileConflictIndex by walking real mods/ folders, deploy, then purge. The
// standing regression this guards (closed once already, #438): a tracked mod's
// `.git/` and `source/` subtrees (ADR-0041) must never be walked, hardlinked into
// Data/, or otherwise disturbed by any of this — deployer.test.ts covers the
// mechanics in isolation; this proves it holds against a real multi-mod instance.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { deploy, purge } from './deployer';
import { buildFileConflictIndex } from './fileConflictIndex';
import type { GameDirectory } from './gameDirectory';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from './test/corpusFixture';

const MANIFEST = 'mods/.medit-manifest.json';
const TRACKED_GIT_HEAD = 'mods/Tracked Patch Mod/.git/HEAD';
const TRACKED_GIT_OBJECT = 'mods/Tracked Patch Mod/.git/objects/deadbeef';
const TRACKED_SOURCE = 'mods/Tracked Patch Mod/source/Tracked Patch Mod.esp/RecordData.json';
const PREEXISTING_OVERWRITE = 'overwrite/F4SE/Plugins/SomePlugin.log';

function fakeReporter() {
  const reports: { severity: string; message: string; detail?: string }[] = [];
  return { reports, report: (severity: string, message: string, detail?: string) => reports.push({ severity, message, detail }) };
}

describe('deploy/purge corpus', () => {
  let dir: string;
  let src: Mo2ModlistSource;
  let gameDirectory: GameDirectory;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
    src = new Mo2ModlistSource(dir);

    // game/Data as a sibling inside the same mkdtemp root, so the deployer's
    // same-volume precheck never false-fails (mirrors test/deployerFixture.ts).
    const dataFolder = join(dir, 'game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    gameDirectory = { root: join(dir, 'game'), dataFolder };

    // Synthesize the tracked mod's .git/ + source/ shape at test-setup time
    // (never committed as literal fixture bytes — a nested .git directory in the
    // outer repo's own tree risks being picked up as a gitlink/submodule).
    const trackedMod = join(dir, 'mods', 'Tracked Patch Mod');
    await mkdir(join(trackedMod, '.git', 'objects'), { recursive: true });
    await writeFile(join(trackedMod, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(trackedMod, '.git', 'objects', 'deadbeef'), 'not a real git object, just the shape');
    await mkdir(join(trackedMod, 'source', 'Tracked Patch Mod.esp'), { recursive: true });
    await writeFile(join(trackedMod, 'source', 'Tracked Patch Mod.esp', 'RecordData.json'), '{}');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function realIndex() {
    const entries = await src.readModlist();
    return buildFileConflictIndex(entries, dir, () => {});
  }

  it('deploy hardlinks only real mod content into Data/, excluding a tracked mod\'s .git/ and source/, touching nothing else', async () => {
    const before = await snapshotTree(dir);
    const reporter = fakeReporter();
    await deploy(dir, gameDirectory, await realIndex(), reporter);
    const after = await snapshotTree(dir);

    expect(reporter.reports.filter((r) => r.severity === 'error')).toEqual([]);

    assertOnlyChanged(
      before,
      after,
      new Set([
        MANIFEST,
        'game/Data/NonAsciiRetexture.esp',
        'game/Data/NonAsciiRetexture - Addon.esl',
        'game/Data/Tracked Patch Mod.esp',
      ]),
    );

    // The exact #438 regression: nothing from .git/ or source/ ever reaches Data/.
    const dataFiles = [...after.keys()].filter((p) => p.startsWith('game/Data/'));
    expect(dataFiles.sort()).toEqual(
      ['game/Data/NonAsciiRetexture - Addon.esl', 'game/Data/NonAsciiRetexture.esp', 'game/Data/Tracked Patch Mod.esp'].sort(),
    );

    const manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'));
    expect(manifest.links.sort()).toEqual(
      ['NonAsciiRetexture.esp', 'NonAsciiRetexture - Addon.esl', 'Tracked Patch Mod.esp'].sort(),
    );
  });

  it('purge removes the links and manifest, restores Data/ to its pre-deploy state, and relocates a stray runtime file into overwrite/', async () => {
    await deploy(dir, gameDirectory, await realIndex(), fakeReporter());

    // A runtime output the game itself wrote into Data/ after deploy (an F4SE log) —
    // not one of our links, not part of the vanilla baseline.
    await mkdir(join(gameDirectory.dataFolder, 'F4SE', 'Logs'), { recursive: true });
    await writeFile(join(gameDirectory.dataFolder, 'F4SE', 'Logs', 'Runtime.log'), 'runtime output');

    const before = await snapshotTree(dir);
    await purge(dir, gameDirectory, fakeReporter());
    const after = await snapshotTree(dir);

    assertOnlyChanged(
      before,
      after,
      new Set([
        MANIFEST, // deleted
        'game/Data/NonAsciiRetexture.esp', // deleted
        'game/Data/NonAsciiRetexture - Addon.esl', // deleted
        'game/Data/Tracked Patch Mod.esp', // deleted
        'game/Data/F4SE/Logs/Runtime.log', // moved out of Data/...
        'overwrite/F4SE/Logs/Runtime.log', // ...and into overwrite/
      ]),
    );

    expect(after.has(MANIFEST)).toBe(false);
    const dataFilesLeft = [...after.keys()].filter((p) => p.startsWith('game/Data/'));
    expect(dataFilesLeft).toEqual([]); // back to the pre-deploy empty Data/
    expect(after.get('overwrite/F4SE/Logs/Runtime.log')?.toString('utf8')).toBe('runtime output');
    // Pre-existing overwrite/ content from a prior session is left exactly alone.
    expect(after.get(PREEXISTING_OVERWRITE)).toEqual(before.get(PREEXISTING_OVERWRITE));
  });

  it('a full deploy-then-purge cycle never touches a tracked mod\'s .git/ or source/ subtree (ADR-0041)', async () => {
    const before = await snapshotTree(dir);
    await deploy(dir, gameDirectory, await realIndex(), fakeReporter());
    await purge(dir, gameDirectory, fakeReporter());
    const after = await snapshotTree(dir);

    // Deploy+purge round-trips Data/ back to empty and removes the manifest — the
    // ONLY residue of the whole cycle anywhere in the instance.
    assertOnlyChanged(before, after, new Set([]));
    expect(before.get(TRACKED_GIT_HEAD)).toEqual(after.get(TRACKED_GIT_HEAD));
    expect(before.get(TRACKED_GIT_OBJECT)).toEqual(after.get(TRACKED_GIT_OBJECT));
    expect(before.get(TRACKED_SOURCE)).toEqual(after.get(TRACKED_SOURCE));
  });
});
