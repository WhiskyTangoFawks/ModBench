import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  trackedFoldersOf, registerTrackedRepositories, pluginRepositoriesOf, pluginAddressKey,
} from '../trackedRepositories';
import type { PluginMetadata } from '../../client';

const modDirsOf = (byOrigin: Record<string, string>): ReadonlyMap<string, string> => new Map(Object.entries(byOrigin));

function makePlugin(overrides: Partial<PluginMetadata> & { path: string; origin: string }): PluginMetadata {
  return {
    name: path.basename(overrides.path),
    loadOrderIndex: 0,
    isLight: false,
    isMaster: false,
    isBlueprint: false,
    masters: [],
    recordCount: 0,
    isImmutable: false,
    inLoadOrder: true,
    masterIssues: [],
    hasMatchingRecords: true,
    isTracked: false,
    hasParseFailure: false,
    ...overrides,
  };
}

describe('trackedFoldersOf', () => {
  it('answers the folder of a tracked origin, and none for its untracked sibling', () => {
    const plugins = [
      makePlugin({ path: '/mods/TrackedMod/Tracked.esp', origin: 'TrackedMod' }),
      makePlugin({ path: '/mods/UntrackedMod/Untracked.esp', origin: 'UntrackedMod' }),
    ];

    const folders = trackedFoldersOf(plugins, new Set(['TrackedMod']), modDirsOf({ TrackedMod: '/mods/TrackedMod' }));

    expect(folders).toEqual(new Map([[pluginAddressKey('Tracked.esp', 'TrackedMod'), '/mods/TrackedMod']]));
  });

  it('keeps two same-name plugins from different mods apart', () => {
    const plugins = [
      makePlugin({ path: '/mods/ModA/Shared.esp', origin: 'ModA' }),
      makePlugin({ path: '/mods/ModB/Shared.esp', origin: 'ModB' }),
    ];

    const folders = trackedFoldersOf(
      plugins, new Set(['ModA', 'ModB']), modDirsOf({ ModA: '/mods/ModA', ModB: '/mods/ModB' }),
    );

    expect(folders.get(pluginAddressKey('Shared.esp', 'ModA'))).toBe('/mods/ModA');
    expect(folders.get(pluginAddressKey('Shared.esp', 'ModB'))).toBe('/mods/ModB');
  });
});

describe('registerTrackedRepositories', () => {
  it('calls openRepository exactly once per distinct mod folder', async () => {
    const openRepository = vi.fn().mockResolvedValue(undefined);

    await registerTrackedRepositories(openRepository, ['/mods/A', '/mods/B']);

    expect(openRepository).toHaveBeenCalledTimes(2);
    expect(openRepository).toHaveBeenCalledWith('/mods/A');
    expect(openRepository).toHaveBeenCalledWith('/mods/B');
  });

  it('never calls openRepository twice for a folder handed twice', async () => {
    const openRepository = vi.fn().mockResolvedValue(undefined);

    await registerTrackedRepositories(openRepository, ['/mods/A', '/mods/A']);

    expect(openRepository).toHaveBeenCalledTimes(1);
  });

  it('resolves to a Map of folder to the repository openRepository returned', async () => {
    const repoA = { name: 'repoA' };
    const repoB = { name: 'repoB' };
    const openRepository = vi.fn((folder: string) => Promise.resolve(folder === '/mods/A' ? repoA : repoB));

    const repositories = await registerTrackedRepositories(openRepository, ['/mods/A', '/mods/B']);

    expect(repositories).toEqual(new Map([['/mods/A', repoA], ['/mods/B', repoB]]));
  });

  it('omits a folder whose openRepository call resolved null, leaving no null-valued entry', async () => {
    const openRepository = vi.fn().mockResolvedValue(null);

    const repositories = await registerTrackedRepositories(openRepository, ['/mods/A']);

    expect(repositories.size).toBe(0);
  });
});

describe('pluginRepositoriesOf', () => {
  it('maps each plugin to the repository resolved for its tracked folder', () => {
    const repoA = { name: 'repoA' };
    const repoB = { name: 'repoB' };
    const folders = new Map([[pluginAddressKey('A.esp', 'ModA'), '/mods/ModA'], [pluginAddressKey('B.esp', 'ModB'), '/mods/ModB']]);
    const folderRepositories = new Map([['/mods/ModA', repoA], ['/mods/ModB', repoB]]);

    const byPlugin = pluginRepositoriesOf(folders, folderRepositories);

    expect(byPlugin).toEqual(new Map([[pluginAddressKey('A.esp', 'ModA'), repoA], [pluginAddressKey('B.esp', 'ModB'), repoB]]));
  });

  it('gives two plugins sharing one folder the same repository', () => {
    const repo = { name: 'repo' };
    const folders = new Map([[pluginAddressKey('A.esp', 'SharedMod'), '/mods/SharedMod'], [pluginAddressKey('B.esp', 'SharedMod'), '/mods/SharedMod']]);

    const byPlugin = pluginRepositoriesOf(folders, new Map([['/mods/SharedMod', repo]]));

    expect(byPlugin).toEqual(new Map([[pluginAddressKey('A.esp', 'SharedMod'), repo], [pluginAddressKey('B.esp', 'SharedMod'), repo]]));
  });

  it('omits a plugin whose folder has no entry in folderRepositories', () => {
    const folders = new Map([[pluginAddressKey('U.esp', 'Declined'), '/mods/Declined']]);

    expect(pluginRepositoriesOf(folders, new Map()).size).toBe(0);
  });
});
