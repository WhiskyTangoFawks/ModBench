import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConflictLookup, type FileConflictIndex } from './fileConflictIndex';
import { buildExplicitPluginsWithOrigin } from './explicitSession';

// #269 / ADR-0036: every explicit plugin also records where it came from — a mod folder, the
// game's Data directory, or MO2's overwrite folder. This ticket only records and reports the
// value; nothing keys on it yet.
//
// Origins are asserted against their literal reserved values ('Data' / 'overwrite'), not against
// the DATA_DIRECTORY_ORIGIN/OVERWRITE_ORIGIN constants explicitSession.ts itself uses to produce
// them — those constants are a documented wire contract (#269/ADR-0036: they match MO2's literal
// directory names), and asserting against the same symbol the code under test reads from would
// pass even if that symbol's value changed.

function index(files: Record<string, { winner: string; winnerMod: string }>): FileConflictIndex {
  const lookup = new FileConflictLookup();
  for (const [relativePath, { winner, winnerMod }] of Object.entries(files)) {
    lookup.set({ relativePath, winner, winnerMod, providers: [winnerMod] });
  }
  return { files: lookup, filesByMod: new Map() };
}

async function makeInstanceRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'medit-explicit-origin-'));
}

describe('buildExplicitPluginsWithOrigin', () => {
  let instanceRoot: string | undefined;
  afterEach(async () => {
    if (instanceRoot) await rm(instanceRoot, { recursive: true, force: true });
    instanceRoot = undefined;
  });

  it('a mod-provided plugin records that mod\'s folder name as origin', async () => {
    instanceRoot = await makeInstanceRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    const source = {
      readPluginOrder: () => Promise.resolve(['Foo.esp']),
      readEnabledPlugins: () => Promise.resolve(['Foo.esp']),
      readModlist: () => Promise.resolve([]),
    };
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', participates: true }]);
  });

  it('a vanilla/DLC/CC plugin no mod provides records the reserved Data-directory origin', async () => {
    instanceRoot = await makeInstanceRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    const source = {
      readPluginOrder: () => Promise.resolve(['Fallout4.esm']),
      readEnabledPlugins: () => Promise.resolve(['Fallout4.esm']),
      readModlist: () => Promise.resolve([]),
    };
    const fakeIndex = index({});

    const result = await buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Fallout4.esm', path: join(dataFolder, 'Fallout4.esm'), origin: 'Data', participates: true }]);
  });

  it('a plugin resolved from MO2\'s overwrite folder records the reserved overwrite origin and wins the path over a mod-provided copy', async () => {
    instanceRoot = await makeInstanceRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    await mkdir(join(instanceRoot, 'overwrite'));
    await writeFile(join(instanceRoot, 'overwrite', 'Foo.esp'), 'overwrite-copy');
    const source = {
      readPluginOrder: () => Promise.resolve(['Foo.esp']),
      readEnabledPlugins: () => Promise.resolve(['Foo.esp']),
      readModlist: () => Promise.resolve([]),
    };
    // A mod also provides Foo.esp — overwrite must win both path and origin (MO2 VFS priority).
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Foo.esp', path: join(instanceRoot, 'overwrite', 'Foo.esp'), origin: 'overwrite', participates: true }]);
  });

  it('no overwrite folder present at all falls through to mod/Data resolution unaffected', async () => {
    instanceRoot = await makeInstanceRoot(); // overwrite/ never created
    const dataFolder = join(instanceRoot, 'game', 'Data');
    const source = {
      readPluginOrder: () => Promise.resolve(['Foo.esp']),
      readEnabledPlugins: () => Promise.resolve(['Foo.esp']),
      readModlist: () => Promise.resolve([]),
    };
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', participates: true }]);
  });

  it('a directory under overwrite/ sharing a plugin\'s name is not treated as that plugin\'s file', async () => {
    instanceRoot = await makeInstanceRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    await mkdir(join(instanceRoot, 'overwrite', 'Foo.esp'), { recursive: true }); // a directory, not a file
    const source = {
      readPluginOrder: () => Promise.resolve(['Foo.esp']),
      readEnabledPlugins: () => Promise.resolve(['Foo.esp']),
      readModlist: () => Promise.resolve([]),
    };
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(fakeIndex));

    // Falls through to the mod-provided copy — the overwrite/ directory entry is excluded.
    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', participates: true }]);
  });

  it('a read failure under overwrite/ other than "missing folder" propagates rather than being swallowed', async () => {
    instanceRoot = await makeInstanceRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    await writeFile(join(instanceRoot, 'overwrite'), 'not a directory'); // readdir on this -> ENOTDIR, not ENOENT
    const source = {
      readPluginOrder: () => Promise.resolve(['Foo.esp']),
      readEnabledPlugins: () => Promise.resolve(['Foo.esp']),
      readModlist: () => Promise.resolve([]),
    };
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    await expect(
      buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(fakeIndex)),
    ).rejects.toThrow();
  });

  it('maps enabled plugins in load order to winner paths and origins (case-insensitive), falling back to Data for an unprovided plugin', async () => {
    instanceRoot = await makeInstanceRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    const source = {
      readPluginOrder: () => Promise.resolve(['Foo.esp', 'Bar.esp', 'Fallout4.esm']),
      readEnabledPlugins: () => Promise.resolve(['Foo.esp', 'Bar.esp', 'Fallout4.esm']),
      readModlist: () => Promise.resolve([]),
    };
    // 'bar.esp' differs in case from the requested 'Bar.esp'; a nested file of the same
    // basename ('textures/Foo.esp') must not be mistaken for the root-level plugin.
    const fakeIndex = index({
      'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' },
      'bar.esp': { winner: '/mods/B/bar.esp', winnerMod: 'B' },
      'textures/Foo.esp': { winner: '/mods/C/textures/Foo.esp', winnerMod: 'C' },
    });

    const result = await buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', participates: true },
      { name: 'Bar.esp', path: '/mods/B/bar.esp', origin: 'B', participates: true },
      { name: 'Fallout4.esm', path: join(dataFolder, 'Fallout4.esm'), origin: 'Data', participates: true },
    ]);
  });
});
