import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConflictLookup, type FileConflictIndex } from './fileConflictIndex';
import { buildLoadOrderSnapshot } from './loadOrderSnapshot';

// ADR-0044: the snapshot Mod Management sends Editing — every physical plugin copy, each
// with its slot, `*` prefix and winning flag. Origins are asserted against their literal reserved
// values ('Data' / 'overwrite'), not against the DATA_DIRECTORY_ORIGIN/OVERWRITE_ORIGIN constants
// the module itself uses to produce them — those constants are a documented wire contract
// (ADR-0036: they match MO2's literal directory names), and asserting against the same symbol
// the code under test reads from would pass even if that symbol's value changed.

type Provider = { winner: string; winnerMod: string; providers?: string[] };

function index(
  files: Record<string, Provider>,
  filesByMod: Record<string, { relativePath: string; absolutePath: string }[]> = {},
): FileConflictIndex {
  const lookup = new FileConflictLookup();
  for (const [relativePath, { winner, winnerMod, providers }] of Object.entries(files)) {
    lookup.set({ relativePath, winner, winnerMod, providers: providers ?? [winnerMod] });
  }
  return { files: lookup, filesByMod: new Map(Object.entries(filesByMod)) };
}

const source = (order: string[], enabled: string[] = order) => ({
  readPluginOrder: () => Promise.resolve(order),
  readEnabledPlugins: () => Promise.resolve(enabled),
  readModlist: () => Promise.resolve([]),
});

describe('buildLoadOrderSnapshot', () => {
  let instanceRoot: string | undefined;
  afterEach(async () => {
    if (instanceRoot) await rm(instanceRoot, { recursive: true, force: true });
    instanceRoot = undefined;
  });
  const root = async () => (instanceRoot = await mkdtemp(join(tmpdir(), 'medit-load-order-snapshot-')));

  it('a mod-provided listed plugin is the winning copy at its plugins.txt slot, with that mod as origin', async () => {
    const dataFolder = join(await root(), 'game', 'Data');
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildLoadOrderSnapshot(source(['Foo.esp']), instanceRoot!, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }]);
  });

  it('a vanilla/DLC/CC plugin no mod provides records the reserved Data-directory origin', async () => {
    const dataFolder = join(await root(), 'game', 'Data');

    const result = await buildLoadOrderSnapshot(source(['Fallout4.esm']), instanceRoot!, dataFolder, () => Promise.resolve(index({})));

    expect(result).toEqual([{ name: 'Fallout4.esm', path: join(dataFolder, 'Fallout4.esm'), origin: 'Data', slot: 0, enabled: true, winning: true }]);
  });

  it('sends every plugins.txt line in slot order, the `*` prefix as enabled, matched case-insensitively', async () => {
    const dataFolder = join(await root(), 'game', 'Data');
    const fakeIndex = index({ 'On.esp': { winner: '/mods/A/On.esp', winnerMod: 'A' } });

    const result = await buildLoadOrderSnapshot(
      source(['On.esp', 'Off.esp', 'Mixed.ESP'], ['On.esp', 'mixed.esp']), instanceRoot!, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'On.esp', path: '/mods/A/On.esp', origin: 'A', slot: 0, enabled: true, winning: true },
      { name: 'Off.esp', path: join(dataFolder, 'Off.esp'), origin: 'Data', slot: 1, enabled: false, winning: true },
      { name: 'Mixed.ESP', path: join(dataFolder, 'Mixed.ESP'), origin: 'Data', slot: 2, enabled: true, winning: true },
    ]);
  });

  // ADR-0044: the losing copy is in the snapshot too — at the name's slot, carrying the line's
  // own `*`, and not winning. Editing registers it beside the winner; only the winner participates.
  it('a file-level loser of a listed name is sent at that slot, enabled as its line says, not winning', async () => {
    const dataFolder = join(await root(), 'game', 'Data');
    const fakeIndex = index(
      { 'Shared.esp': { winner: '/mods/A/Shared.esp', winnerMod: 'A', providers: ['A', 'B'] } },
      {
        A: [{ relativePath: 'Shared.esp', absolutePath: '/mods/A/Shared.esp' }],
        B: [{ relativePath: 'Shared.esp', absolutePath: '/mods/B/Shared.esp' }],
      },
    );

    const result = await buildLoadOrderSnapshot(source(['Other.esp', 'Shared.esp']), instanceRoot!, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/A/Shared.esp', origin: 'A', slot: 1, enabled: true, winning: true });
    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/B/Shared.esp', origin: 'B', slot: 1, enabled: true, winning: false });
  });

  it('a plugin file no plugins.txt line names is sent with no slot, not enabled, winning if it is the sole provider', async () => {
    const dataFolder = join(await root(), 'game', 'Data');
    const fakeIndex = index(
      { 'Stray.esp': { winner: '/mods/C/Stray.esp', winnerMod: 'C' } },
      { C: [{ relativePath: 'Stray.esp', absolutePath: '/mods/C/Stray.esp' }, { relativePath: 'textures/x.dds', absolutePath: '/mods/C/textures/x.dds' }] },
    );

    const result = await buildLoadOrderSnapshot(source(['Listed.esp']), instanceRoot!, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'Listed.esp', path: join(dataFolder, 'Listed.esp'), origin: 'Data', slot: 0, enabled: true, winning: true },
      { name: 'Stray.esp', path: '/mods/C/Stray.esp', origin: 'C', slot: null, enabled: false, winning: true },
    ]);
  });

  it('a plugin resolved from overwrite/ wins path and origin over a mod-provided copy, which is then sent as losing', async () => {
    const dataFolder = join(await root(), 'game', 'Data');
    await mkdir(join(instanceRoot!, 'overwrite'));
    await writeFile(join(instanceRoot!, 'overwrite', 'Foo.esp'), 'overwrite-copy');
    const fakeIndex = index(
      { 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } },
      { A: [{ relativePath: 'Foo.esp', absolutePath: '/mods/A/Foo.esp' }] },
    );

    const result = await buildLoadOrderSnapshot(source(['Foo.esp']), instanceRoot!, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'Foo.esp', path: join(instanceRoot!, 'overwrite', 'Foo.esp'), origin: 'overwrite', slot: 0, enabled: true, winning: true },
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: false },
    ]);
  });

  it('an unlisted plugin sitting in overwrite/ is sent with no slot, winning-most', async () => {
    const dataFolder = join(await root(), 'game', 'Data');
    await mkdir(join(instanceRoot!, 'overwrite'));
    await writeFile(join(instanceRoot!, 'overwrite', 'New.esp'), '');
    await writeFile(join(instanceRoot!, 'overwrite', 'notes.txt'), '');

    const result = await buildLoadOrderSnapshot(source([]), instanceRoot!, dataFolder, () => Promise.resolve(index({})));

    expect(result).toEqual([
      { name: 'New.esp', path: join(instanceRoot!, 'overwrite', 'New.esp'), origin: 'overwrite', slot: null, enabled: false, winning: true },
    ]);
  });

  it('no overwrite folder present at all falls through to mod/Data resolution unaffected', async () => {
    const dataFolder = join(await root(), 'game', 'Data'); // overwrite/ never created
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildLoadOrderSnapshot(source(['Foo.esp']), instanceRoot!, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }]);
  });

  it('a directory under overwrite/ sharing a plugin\'s name is not treated as that plugin\'s file', async () => {
    const dataFolder = join(await root(), 'game', 'Data');
    await mkdir(join(instanceRoot!, 'overwrite', 'Foo.esp'), { recursive: true }); // a directory, not a file
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildLoadOrderSnapshot(source(['Foo.esp']), instanceRoot!, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }]);
  });

  it('a read failure under overwrite/ other than "missing folder" propagates rather than being swallowed', async () => {
    const dataFolder = join(await root(), 'game', 'Data');
    await writeFile(join(instanceRoot!, 'overwrite'), 'not a directory'); // readdir on this -> ENOTDIR, not ENOENT
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    await expect(
      buildLoadOrderSnapshot(source(['Foo.esp']), instanceRoot!, dataFolder, () => Promise.resolve(fakeIndex)),
    ).rejects.toThrow();
  });

  it('maps names to winner paths case-insensitively, never mistaking a nested file for the root-level plugin', async () => {
    const dataFolder = join(await root(), 'game', 'Data');
    const fakeIndex = index({
      'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' },
      'bar.esp': { winner: '/mods/B/bar.esp', winnerMod: 'B' },
      'textures/Foo.esp': { winner: '/mods/C/textures/Foo.esp', winnerMod: 'C' },
    });

    const result = await buildLoadOrderSnapshot(
      source(['Foo.esp', 'Bar.esp', 'Fallout4.esm']), instanceRoot!, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true },
      { name: 'Bar.esp', path: '/mods/B/bar.esp', origin: 'B', slot: 1, enabled: true, winning: true },
      { name: 'Fallout4.esm', path: join(dataFolder, 'Fallout4.esm'), origin: 'Data', slot: 2, enabled: true, winning: true },
    ]);
  });
});
