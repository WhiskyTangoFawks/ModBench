import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  trackedModFoldersOf, registerTrackedRepositories, pluginRepositoriesOf, pluginAddressKey,
  type IsTracked, type PluginFolder,
} from '../trackedRepositories';
import type { PluginMetadata } from '../../client';

// The Instance adapter's two answers, doubled at the ports this box declares for them.
const pluginFolder: PluginFolder = (pluginFile) => path.dirname(pluginFile);
const trackedAmong = (tracked: readonly string[]): IsTracked => (modFolder) => Promise.resolve(tracked.includes(modFolder));

function makePlugin(overrides: Partial<PluginMetadata> & { path: string; origin: string }): PluginMetadata {
  return {
    name: path.basename(overrides.path),
    loadOrderIndex: 0,
    isLight: false,
    isMaster: false,
    masters: [],
    recordCount: 0,
    isImmutable: false,
    enabled: true, winning: true, participates: true, inLoadOrder: true,
    masterIssues: [],
    hasMatchingRecords: true,
    isTracked: false,
    hasParseFailure: false,
    ...overrides,
  };
}

// ── trackedModFoldersOf ────────────────────────────────────────────────────

describe('trackedModFoldersOf', () => {
  it('finds the mod folder the Instance adapter answers tracked, and not its untracked sibling', async () => {
    const plugins = [
      makePlugin({ path: '/mods/TrackedMod/Tracked.esp', origin: 'TrackedMod' }),
      // Positive control, checked through the identical function call: the untracked sibling
      // must be absent, proving the tracked one's presence means something.
      makePlugin({ path: '/mods/UntrackedMod/Untracked.esp', origin: 'UntrackedMod' }),
    ];

    const folders = await trackedModFoldersOf(plugins, trackedAmong(['/mods/TrackedMod']), pluginFolder);

    expect(folders).toEqual(['/mods/TrackedMod']);
  });

  it('deduplicates two plugins sharing one tracked mod folder', async () => {
    const plugins = [
      makePlugin({ path: '/mods/SharedMod/A.esp', origin: 'SharedMod' }),
      makePlugin({ path: '/mods/SharedMod/B.esp', origin: 'SharedMod' }),
    ];

    const folders = await trackedModFoldersOf(plugins, trackedAmong(['/mods/SharedMod']), pluginFolder);

    expect(folders).toEqual(['/mods/SharedMod']);
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

    // trackedModFoldersOf already dedupes, but "no duplicate SCM registration" is this
    // function's own contract too — it must not re-introduce a duplicate even if handed
    // one, e.g. by a caller that merged two plugin lists without re-deduping.
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
  it("maps each plugin to the repository resolved for its mod folder", () => {
    const repoA = { name: 'repoA' };
    const repoB = { name: 'repoB' };
    const plugins = [
      makePlugin({ path: '/mods/ModA/A.esp', origin: 'ModA' }),
      makePlugin({ path: '/mods/ModB/B.esp', origin: 'ModB' }),
    ];
    const folderRepositories = new Map([['/mods/ModA', repoA], ['/mods/ModB', repoB]]);

    const byPlugin = pluginRepositoriesOf(plugins, folderRepositories, pluginFolder);

    expect(byPlugin).toEqual(new Map([[pluginAddressKey('A.esp', 'ModA'), repoA], [pluginAddressKey('B.esp', 'ModB'), repoB]]));
  });

  it("takes each plugin's mod folder from the Instance adapter's answer", () => {
    const repo = { name: 'repo' };
    const plugins = [makePlugin({ path: '/mods/ModA/A.esp', origin: 'ModA' })];

    const byPlugin = pluginRepositoriesOf(plugins, new Map([['/answered', repo]]), () => '/answered');

    expect(byPlugin).toEqual(new Map([[pluginAddressKey('A.esp', 'ModA'), repo]]));
  });

  it('gives two plugins sharing one mod folder the same repository', () => {
    const repo = { name: 'repo' };
    const plugins = [
      makePlugin({ path: '/mods/SharedMod/A.esp', origin: 'SharedMod' }),
      makePlugin({ path: '/mods/SharedMod/B.esp', origin: 'SharedMod' }),
    ];
    const folderRepositories = new Map([['/mods/SharedMod', repo]]);

    const byPlugin = pluginRepositoriesOf(plugins, folderRepositories, pluginFolder);

    expect(byPlugin).toEqual(new Map([[pluginAddressKey('A.esp', 'SharedMod'), repo], [pluginAddressKey('B.esp', 'SharedMod'), repo]]));
  });

  // ADR-0012 invariant 1: two plugins that share a filename each have their own repository.
  it('keeps two same-name plugins from different mods apart', () => {
    const repoA = { name: 'repoA' };
    const repoB = { name: 'repoB' };
    const plugins = [
      makePlugin({ path: '/mods/ModA/Shared.esp', origin: 'ModA' }),
      makePlugin({ path: '/mods/ModB/Shared.esp', origin: 'ModB' }),
    ];
    const folderRepositories = new Map([['/mods/ModA', repoA], ['/mods/ModB', repoB]]);

    const byPlugin = pluginRepositoriesOf(plugins, folderRepositories, pluginFolder);

    expect(byPlugin.get(pluginAddressKey('Shared.esp', 'ModA'))).toBe(repoA);
    expect(byPlugin.get(pluginAddressKey('Shared.esp', 'ModB'))).toBe(repoB);
  });

  it('omits a plugin whose own mod folder has no entry in folderRepositories', () => {
    // e.g. an untracked plugin, or one whose openRepository call declined (registerTrackedRepositories
    // already dropped that folder from the map) — never a null-valued entry a later `.status()` call
    // would crash on.
    const plugins = [makePlugin({ path: '/mods/Untracked/U.esp', origin: 'Untracked' })];

    const byPlugin = pluginRepositoriesOf(plugins, new Map(), pluginFolder);

    expect(byPlugin.size).toBe(0);
  });
});
