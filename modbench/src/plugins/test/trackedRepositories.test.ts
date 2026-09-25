import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { trackedModFoldersOf, registerTrackedRepositories, pluginRepositoriesOf, pluginCopyKey } from '../trackedRepositories';
import { isTracked } from '../../instanceAdapter/files';
import { pluginFolder } from '../../instanceAdapter/layout';
import type { PluginMetadata } from '../../client';

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
  // The Instance adapter answers "is this tracked", so the real answer is what this composes with.
  it('finds a tracked mod folder — one whose folder contains .git — via a real filesystem check', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-tracked-'));
    const trackedFolder = path.join(root, 'TrackedMod');
    const untrackedFolder = path.join(root, 'UntrackedMod');
    fs.mkdirSync(path.join(trackedFolder, '.git'), { recursive: true });
    fs.mkdirSync(untrackedFolder, { recursive: true });
    try {
      const plugins = [
        makePlugin({ path: path.join(trackedFolder, 'Tracked.esp'), origin: 'TrackedMod' }),
        // Positive control, checked through the identical function call: the untracked sibling
        // must be absent, proving the tracked one's presence means something.
        makePlugin({ path: path.join(untrackedFolder, 'Untracked.esp'), origin: 'UntrackedMod' }),
      ];

      const folders = await trackedModFoldersOf(plugins, isTracked, pluginFolder);

      expect(folders).toEqual([trackedFolder]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates two plugins sharing one tracked mod folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-tracked-'));
    const modFolder = path.join(root, 'SharedMod');
    fs.mkdirSync(path.join(modFolder, '.git'), { recursive: true });
    try {
      const plugins = [
        makePlugin({ path: path.join(modFolder, 'A.esp'), origin: 'SharedMod' }),
        makePlugin({ path: path.join(modFolder, 'B.esp'), origin: 'SharedMod' }),
      ];

      const folders = await trackedModFoldersOf(plugins, isTracked, pluginFolder);

      expect(folders).toEqual([modFolder]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
  it("maps each plugin copy to the repository resolved for its mod folder", () => {
    const repoA = { name: 'repoA' };
    const repoB = { name: 'repoB' };
    const plugins = [
      makePlugin({ path: '/mods/ModA/A.esp', origin: 'ModA' }),
      makePlugin({ path: '/mods/ModB/B.esp', origin: 'ModB' }),
    ];
    const folderRepositories = new Map([['/mods/ModA', repoA], ['/mods/ModB', repoB]]);

    const byPlugin = pluginRepositoriesOf(plugins, folderRepositories, pluginFolder);

    expect(byPlugin).toEqual(new Map([[pluginCopyKey('A.esp', 'ModA'), repoA], [pluginCopyKey('B.esp', 'ModB'), repoB]]));
  });

  it("takes each plugin's mod folder from the Instance adapter's answer", () => {
    const repo = { name: 'repo' };
    const plugins = [makePlugin({ path: '/mods/ModA/A.esp', origin: 'ModA' })];

    const byPlugin = pluginRepositoriesOf(plugins, new Map([['/answered', repo]]), () => '/answered');

    expect(byPlugin).toEqual(new Map([[pluginCopyKey('A.esp', 'ModA'), repo]]));
  });

  it('gives two plugins sharing one mod folder the same repository', () => {
    const repo = { name: 'repo' };
    const plugins = [
      makePlugin({ path: '/mods/SharedMod/A.esp', origin: 'SharedMod' }),
      makePlugin({ path: '/mods/SharedMod/B.esp', origin: 'SharedMod' }),
    ];
    const folderRepositories = new Map([['/mods/SharedMod', repo]]);

    const byPlugin = pluginRepositoriesOf(plugins, folderRepositories, pluginFolder);

    expect(byPlugin).toEqual(new Map([[pluginCopyKey('A.esp', 'SharedMod'), repo], [pluginCopyKey('B.esp', 'SharedMod'), repo]]));
  });

  // ADR-0012 invariant 1: two copies of one filename are two plugins, each with its own repository.
  it('keeps two same-name plugins from different mods apart', () => {
    const repoA = { name: 'repoA' };
    const repoB = { name: 'repoB' };
    const plugins = [
      makePlugin({ path: '/mods/ModA/Shared.esp', origin: 'ModA' }),
      makePlugin({ path: '/mods/ModB/Shared.esp', origin: 'ModB' }),
    ];
    const folderRepositories = new Map([['/mods/ModA', repoA], ['/mods/ModB', repoB]]);

    const byPlugin = pluginRepositoriesOf(plugins, folderRepositories, pluginFolder);

    expect(byPlugin.get(pluginCopyKey('Shared.esp', 'ModA'))).toBe(repoA);
    expect(byPlugin.get(pluginCopyKey('Shared.esp', 'ModB'))).toBe(repoB);
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
