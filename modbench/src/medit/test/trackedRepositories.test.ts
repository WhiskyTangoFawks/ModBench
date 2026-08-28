import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { trackedModFoldersOf, registerTrackedRepositories } from '../trackedRepositories';
import type { PluginMetadata } from '../ApiClient';

function makePlugin(overrides: Partial<PluginMetadata> & { path: string; origin: string }): PluginMetadata {
  return {
    name: path.basename(overrides.path),
    loadOrderIndex: 0,
    isLight: false,
    isMaster: false,
    masters: [],
    recordCount: 0,
    isImmutable: false,
    masterIssues: [],
    hasMatchingRecords: true,
    compilePending: false,
    lastCompiledAt: null,
    ...overrides,
  };
}

// ── trackedModFoldersOf (#414) ───────────────────────────────────────────────

describe('trackedModFoldersOf', () => {
  it('finds a tracked mod folder — one whose folder contains .git — via a real filesystem check', () => {
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

      const folders = trackedModFoldersOf(plugins);

      expect(folders).toEqual([trackedFolder]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates two plugins sharing one tracked mod folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-tracked-'));
    const modFolder = path.join(root, 'SharedMod');
    fs.mkdirSync(path.join(modFolder, '.git'), { recursive: true });
    try {
      const plugins = [
        makePlugin({ path: path.join(modFolder, 'A.esp'), origin: 'SharedMod' }),
        makePlugin({ path: path.join(modFolder, 'B.esp'), origin: 'SharedMod' }),
      ];

      const folders = trackedModFoldersOf(plugins);

      expect(folders).toEqual([modFolder]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── registerTrackedRepositories (#414 AC: no duplicate SCM registration) ────

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

    // trackedModFoldersOf already dedupes, but this function is the AC's own contract
    // ("no duplicate SCM registration") — it must not re-introduce a duplicate even if handed
    // one, e.g. by a caller that merged two plugin lists without re-deduping.
    await registerTrackedRepositories(openRepository, ['/mods/A', '/mods/A']);

    expect(openRepository).toHaveBeenCalledTimes(1);
  });
});
