import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConflictLookup, type FileConflictIndex } from './fileConflictIndex';
import { resolveCurrentPluginOrigins, buildExplicitPluginsWithOrigin } from './explicitSession';

// #279 / ADR-0035 § Live mutation: what a plugin name resolves to *right now*, which is the Mod
// Management half of drift — the loaded half comes from the session, and the two are compared at
// the composition root so neither context learns the other's vocabulary.
//
// The same overwrite → winning mod → Data ladder buildExplicitPluginsWithOrigin walks, with one
// addition that only matters here: the Data fallback is checked for existence. A session build
// resolves names that are known to exist; drift has to answer for a name that resolves to
// *nothing*, which is what uninstalling the only provider of a plugin leaves behind.
//
// Origins are asserted against their literal reserved values ('Data' / 'overwrite'), not the
// constants the code under test reads from — asserting against the same symbol would pass even if
// that symbol's value changed.

function index(files: Record<string, { winner: string; winnerMod: string }>): FileConflictIndex {
  const lookup = new FileConflictLookup();
  for (const [relativePath, { winner, winnerMod }] of Object.entries(files)) {
    lookup.set({ relativePath, winner, winnerMod, providers: [winnerMod] });
  }
  return { files: lookup, filesByMod: new Map() };
}

describe('resolveCurrentPluginOrigins', () => {
  let instanceRoot: string | undefined;
  afterEach(async () => {
    if (instanceRoot) await rm(instanceRoot, { recursive: true, force: true });
    instanceRoot = undefined;
  });

  const makeRoot = () => mkdtemp(join(tmpdir(), 'medit-current-origin-'));

  it('a mod-provided plugin resolves to that mod folder', async () => {
    instanceRoot = await makeRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await resolveCurrentPluginOrigins(['Foo.esp'], fakeIndex, instanceRoot, dataFolder);

    expect(result.get('foo.esp')).toEqual({ origin: 'A', path: '/mods/A/Foo.esp' });
  });

  it('a plugin in MO2\'s overwrite folder resolves there, above any mod-provided copy', async () => {
    instanceRoot = await makeRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    await mkdir(join(instanceRoot, 'overwrite'));
    await writeFile(join(instanceRoot, 'overwrite', 'Foo.esp'), 'overwrite-copy');
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await resolveCurrentPluginOrigins(['Foo.esp'], fakeIndex, instanceRoot, dataFolder);

    expect(result.get('foo.esp')).toEqual({
      origin: 'overwrite',
      path: join(instanceRoot, 'overwrite', 'Foo.esp'),
    });
  });

  it('a plugin no mod provides but the game\'s Data folder holds resolves to the reserved Data origin', async () => {
    instanceRoot = await makeRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), 'vanilla');

    const result = await resolveCurrentPluginOrigins(['Fallout4.esm'], index({}), instanceRoot, dataFolder);

    expect(result.get('fallout4.esm')).toEqual({ origin: 'Data', path: join(dataFolder, 'Fallout4.esm') });
  });

  // The case the whole "resolves to nothing" branch exists for: uninstalling the only mod that
  // provided a plugin. The session still holds its records, but the name now points at no file,
  // so there is nothing to re-read — which is what the drifted row has to be able to say.
  it('a plugin nothing provides and Data does not hold resolves to nothing', async () => {
    instanceRoot = await makeRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    await mkdir(dataFolder, { recursive: true });

    const result = await resolveCurrentPluginOrigins(['Gone.esp'], index({}), instanceRoot, dataFolder);

    // Present as a key with a null value, not absent: "asked and the answer is nothing" must be
    // distinguishable from "never asked", which is what a missing key would mean to the caller.
    expect(result.has('gone.esp')).toBe(true);
    expect(result.get('gone.esp')).toBeNull();
  });

  it('resolves every name it is given, keyed case-insensitively', async () => {
    instanceRoot = await makeRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    const fakeIndex = index({ 'foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    // plugins.txt casing is not authoritative anywhere else in this module, and it is not here.
    const result = await resolveCurrentPluginOrigins(['FOO.ESP', 'Gone.esp'], fakeIndex, instanceRoot, dataFolder);

    expect([...result.keys()].sort()).toEqual(['foo.esp', 'gone.esp']);
    expect(result.get('foo.esp')?.origin).toBe('A');
  });

  it('a directory in the Data folder sharing a plugin\'s name is not a file to resolve to', async () => {
    instanceRoot = await makeRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    await mkdir(join(dataFolder, 'Gone.esp'), { recursive: true });

    const result = await resolveCurrentPluginOrigins(['Gone.esp'], index({}), instanceRoot, dataFolder);

    expect(result.get('gone.esp')).toBeNull();
  });

  it('no resolvable Data folder still answers for every name rather than throwing', async () => {
    instanceRoot = await makeRoot();

    const result = await resolveCurrentPluginOrigins(['Gone.esp'], index({}), instanceRoot, undefined);

    expect(result.get('gone.esp')).toBeNull();
  });

  // The invariant that keeps drift meaningful, pinned rather than left to prose. These two
  // functions walk the same overwrite → winning mod → Data ladder for two different callers, and
  // drift is *defined* as the difference between what one of them said at load time and what the
  // other says now. If they ever disagreed about an unchanged loadout, every row would flag as
  // drifted and the feature would be noise — a failure that is invisible in either function's own
  // tests, because each would still be self-consistently right.
  it('agrees with the session builder about an unchanged loadout, so nothing drifts spuriously', async () => {
    instanceRoot = await makeRoot();
    const dataFolder = join(instanceRoot, 'game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), 'vanilla');
    await mkdir(join(instanceRoot, 'overwrite'));
    await writeFile(join(instanceRoot, 'overwrite', 'Stray.esp'), 'overwrite-copy');
    const names = ['Foo.esp', 'Fallout4.esm', 'Stray.esp'];
    const fakeIndex = index({
      'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' },
      'Stray.esp': { winner: '/mods/B/Stray.esp', winnerMod: 'B' },
    });
    const source = {
      readPluginOrder: () => Promise.resolve(names),
      readEnabledPlugins: () => Promise.resolve(names),
      readModlist: () => Promise.resolve([]),
    };

    const loaded = await buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(fakeIndex));
    const current = await resolveCurrentPluginOrigins(names, fakeIndex, instanceRoot, dataFolder);

    for (const plugin of loaded) {
      expect(current.get(plugin.name.toLowerCase())).toEqual({ origin: plugin.origin, path: plugin.path });
    }
  });
});
