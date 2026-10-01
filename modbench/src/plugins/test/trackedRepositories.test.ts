import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  trackedFoldersOf, registerTrackedRepositories, pluginRepositoriesOf, pluginAddressKey, type TrackedFolderOf,
} from '../trackedRepositories';
import type { PluginMetadata } from '../../client';

// The Instance adapter's answer, doubled at the port this box declares for it.
const trackedAmong = (tracked: readonly string[]): TrackedFolderOf => (pluginFile) =>
  Promise.resolve(tracked.find((folder) => path.dirname(pluginFile) === folder));

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

// ── trackedFoldersOf ────────────────────────────────────────────────────

describe('trackedFoldersOf', () => {
  it('answers the folder the Instance adapter answers tracked, and none for its untracked sibling', async () => {
    const plugins = [
      makePlugin({ path: '/mods/TrackedMod/Tracked.esp', origin: 'TrackedMod' }),
      // Positive control, checked through the identical function call: the untracked sibling
      // must be absent, proving the tracked one's presence means something.
      makePlugin({ path: '/mods/UntrackedMod/Untracked.esp', origin: 'UntrackedMod' }),
    ];

    const folders = await trackedFoldersOf(plugins, trackedAmong(['/mods/TrackedMod']));

    expect(folders).toEqual(new Map([[pluginAddressKey('Tracked.esp', 'TrackedMod'), '/mods/TrackedMod']]));
  });

  // ADR-0012 invariant 1: two plugins that share a filename each have their own folder.
  it('keeps two same-name plugins from different mods apart', async () => {
    const plugins = [
      makePlugin({ path: '/mods/ModA/Shared.esp', origin: 'ModA' }),
      makePlugin({ path: '/mods/ModB/Shared.esp', origin: 'ModB' }),
    ];

    const folders = await trackedFoldersOf(plugins, trackedAmong(['/mods/ModA', '/mods/ModB']));

    expect(folders.get(pluginAddressKey('Shared.esp', 'ModA'))).toBe('/mods/ModA');
    expect(folders.get(pluginAddressKey('Shared.esp', 'ModB'))).toBe('/mods/ModB');
  });
});

// ── registerTrackedRepositories (no duplicate SCM registration) ─────────────

describe('registerTrackedRepositories', () => {
  it('calls openRepository exactly once per distinct mod folder', async () => {
    const openRepository = vi.fn().mockResolvedValue(undefined);

    await registerTrackedRepositories(openRepository, ['/mods/A', '/mods/B']);

    expect(openRepository).toHaveBeenCalledTimes(2);
    expect(openRepository).toHaveBeenCalledWith('/mods/A');
    expect(openRepository).toHaveBeenCalledWith('/mods/B');
  });

  it('never calls openRepository twice for the same folder', async () => {
    const openRepository = vi.fn().mockResolvedValue(undefined);

    // The caller hands one folder per tracked plugin, so two plugins sharing a folder hand it twice.
    await registerTrackedRepositories(openRepository, ['/mods/A', '/mods/A']);

    expect(openRepository).toHaveBeenCalledTimes(1);
  });

  // The returned repository handles are what extension.ts keeps around to prompt a
  // post-edit Source Control status refresh — discarding them would leave nothing to refresh.
  it('resolves to a Map of folder to the repository openRepository returned', async () => {
    const repoA = { name: 'repoA' };
    const repoB = { name: 'repoB' };
    const openRepository = vi.fn((folder: string) => Promise.resolve(folder === '/mods/A' ? repoA : repoB));

    const repositories = await registerTrackedRepositories(openRepository, ['/mods/A', '/mods/B']);

    expect(repositories).toEqual(new Map([['/mods/A', repoA], ['/mods/B', repoB]]));
  });

  it('omits a folder whose openRepository call resolved null', async () => {
    // The real `vscode.git` API's own `openRepository` return type is `Repository | null` — a
    // null here must not become a null-valued map entry a later `.status()` call would crash on.
    const openRepository = vi.fn().mockResolvedValue(null);

    const repositories = await registerTrackedRepositories(openRepository, ['/mods/A']);

    expect(repositories.size).toBe(0);
  });
});

// ── pluginRepositoriesOf (extension.ts carries no business logic) ──────────────────────────────

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
    // A folder whose openRepository call declined (registerTrackedRepositories already dropped it
    // from the map) — never a null-valued entry a later `.status()` call would crash on.
    const folders = new Map([[pluginAddressKey('U.esp', 'Declined'), '/mods/Declined']]);

    expect(pluginRepositoriesOf(folders, new Map()).size).toBe(0);
  });
});
