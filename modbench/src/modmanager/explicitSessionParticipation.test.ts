import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConflictLookup, type FileConflictIndex } from './fileConflictIndex';
import { buildExplicitPluginsWithOrigin } from './explicitSession';

// #270 / ADR-0035: the editing session indexes every plugins.txt line, enabled and disabled alike.
// The `*` prefix stops being a filter on which plugins are sent and becomes participation — whether
// that plugin loads in the game and so competes for winner.

function index(files: Record<string, { winner: string; winnerMod: string }>): FileConflictIndex {
  const lookup = new FileConflictLookup();
  for (const [relativePath, { winner, winnerMod }] of Object.entries(files)) {
    lookup.set({ relativePath, winner, winnerMod, providers: [winnerMod] });
  }
  return { files: lookup, filesByMod: new Map() };
}

describe('buildExplicitPluginsWithOrigin participation', () => {
  let instanceRoot: string | undefined;
  afterEach(async () => {
    if (instanceRoot) await rm(instanceRoot, { recursive: true, force: true });
    instanceRoot = undefined;
  });

  it('sends every plugins.txt line, in order, with the `*` prefix as participation', async () => {
    instanceRoot = await mkdtemp(join(tmpdir(), 'medit-explicit-participation-'));
    const dataFolder = join(instanceRoot, 'game', 'Data');
    const source = {
      readPluginOrder: () => Promise.resolve(['On.esp', 'Off.esp', 'AlsoOn.esp']),
      readEnabledPlugins: () => Promise.resolve(['On.esp', 'AlsoOn.esp']),
      readModlist: () => Promise.resolve([]),
    };
    const fakeIndex = index({ 'On.esp': { winner: '/mods/A/On.esp', winnerMod: 'A' } });

    const result = await buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'On.esp', path: '/mods/A/On.esp', origin: 'A', participates: true },
      { name: 'Off.esp', path: join(dataFolder, 'Off.esp'), origin: 'Data', participates: false },
      { name: 'AlsoOn.esp', path: join(dataFolder, 'AlsoOn.esp'), origin: 'Data', participates: true },
    ]);
  });

  // plugins.txt casing is not authoritative anywhere else in this module (path resolution is
  // case-insensitive), so participation must not be the one place a case difference silently
  // disables a plugin.
  it('matches the enabled set case-insensitively', async () => {
    instanceRoot = await mkdtemp(join(tmpdir(), 'medit-explicit-participation-case-'));
    const dataFolder = join(instanceRoot, 'game', 'Data');
    const source = {
      readPluginOrder: () => Promise.resolve(['Mixed.ESP']),
      readEnabledPlugins: () => Promise.resolve(['mixed.esp']),
      readModlist: () => Promise.resolve([]),
    };

    const result = await buildExplicitPluginsWithOrigin(source, instanceRoot, dataFolder, () => Promise.resolve(index({})));

    expect(result[0].participates).toBe(true);
  });
});
