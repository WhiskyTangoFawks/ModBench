import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConflictLookup, type FileConflictIndex } from '../fileConflictIndex';
import { buildLoadOrderSnapshot, originFolder, providedPluginsOf, resolvePluginPaths } from '../loadOrderSnapshot';

// Origins are asserted against their literal reserved values, not the constants the module uses
// to produce them: those are a wire contract (ADR-0012), and asserting against the same symbol
// would pass even if its value changed.

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
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildLoadOrderSnapshot(source(['Foo.esp']), instanceDir, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }]);
  });

  it('a vanilla/DLC/CC plugin no mod provides records the reserved Data-directory origin', async () => {
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');

    const result = await buildLoadOrderSnapshot(source(['Fallout4.esm']), instanceDir, dataFolder, () => Promise.resolve(index({})));

    expect(result).toEqual([{ name: 'Fallout4.esm', path: join(dataFolder, 'Fallout4.esm'), origin: 'Data', slot: 0, enabled: true, winning: true }]);
  });

  it('sends every plugins.txt line in slot order, the `*` prefix as enabled, matched case-insensitively', async () => {
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');
    const fakeIndex = index({ 'On.esp': { winner: '/mods/A/On.esp', winnerMod: 'A' } });

    const result = await buildLoadOrderSnapshot(
      source(['On.esp', 'Off.esp', 'Mixed.ESP'], ['On.esp', 'mixed.esp']), instanceDir, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'On.esp', path: '/mods/A/On.esp', origin: 'A', slot: 0, enabled: true, winning: true },
      { name: 'Off.esp', path: join(dataFolder, 'Off.esp'), origin: 'Data', slot: 1, enabled: false, winning: true },
      { name: 'Mixed.ESP', path: join(dataFolder, 'Mixed.ESP'), origin: 'Data', slot: 2, enabled: true, winning: true },
    ]);
  });

  // ADR-0013: the losing copy is in the snapshot too — at the name's slot, carrying the line's
  // own `*`, and not winning. Editing registers it beside the winner; only the winner participates.
  it('a file-level loser of a listed name is sent at that slot, enabled as its line says, not winning', async () => {
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');
    const fakeIndex = index(
      { 'Shared.esp': { winner: '/mods/A/Shared.esp', winnerMod: 'A', providers: ['A', 'B'] } },
      {
        A: [{ relativePath: 'Shared.esp', absolutePath: '/mods/A/Shared.esp' }],
        B: [{ relativePath: 'Shared.esp', absolutePath: '/mods/B/Shared.esp' }],
      },
    );

    const result = await buildLoadOrderSnapshot(source(['Other.esp', 'Shared.esp']), instanceDir, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/A/Shared.esp', origin: 'A', slot: 1, enabled: true, winning: true });
    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/B/Shared.esp', origin: 'B', slot: 1, enabled: true, winning: false });
  });

  it('a plugin file no plugins.txt line names is sent with no slot, not enabled, winning if it is the sole provider', async () => {
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');
    const fakeIndex = index(
      { 'Stray.esp': { winner: '/mods/C/Stray.esp', winnerMod: 'C' } },
      { C: [{ relativePath: 'Stray.esp', absolutePath: '/mods/C/Stray.esp' }, { relativePath: 'textures/x.dds', absolutePath: '/mods/C/textures/x.dds' }] },
    );

    const result = await buildLoadOrderSnapshot(source(['Listed.esp']), instanceDir, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'Listed.esp', path: join(dataFolder, 'Listed.esp'), origin: 'Data', slot: 0, enabled: true, winning: true },
      { name: 'Stray.esp', path: '/mods/C/Stray.esp', origin: 'C', slot: null, enabled: false, winning: true },
    ]);
  });

  it('a plugin resolved from overwrite/ wins path and origin over a mod-provided copy, which is then sent as losing', async () => {
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');
    await mkdir(join(instanceDir, 'overwrite'));
    await writeFile(join(instanceDir, 'overwrite', 'Foo.esp'), 'overwrite-copy');
    const fakeIndex = index(
      { 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } },
      { A: [{ relativePath: 'Foo.esp', absolutePath: '/mods/A/Foo.esp' }] },
    );

    const result = await buildLoadOrderSnapshot(source(['Foo.esp']), instanceDir, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'Foo.esp', path: join(instanceDir, 'overwrite', 'Foo.esp'), origin: 'overwrite', slot: 0, enabled: true, winning: true },
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: false },
    ]);
  });

  it('an unlisted plugin sitting in overwrite/ is sent with no slot, winning-most', async () => {
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');
    await mkdir(join(instanceDir, 'overwrite'));
    await writeFile(join(instanceDir, 'overwrite', 'New.esp'), '');
    await writeFile(join(instanceDir, 'overwrite', 'notes.txt'), '');

    const result = await buildLoadOrderSnapshot(source([]), instanceDir, dataFolder, () => Promise.resolve(index({})));

    expect(result).toEqual([
      { name: 'New.esp', path: join(instanceDir, 'overwrite', 'New.esp'), origin: 'overwrite', slot: null, enabled: false, winning: true },
    ]);
  });

  it('no overwrite folder present at all falls through to mod/Data resolution unaffected', async () => {
    const instanceDir = await root(); // overwrite/ never created

    const dataFolder = join(instanceDir, 'game', 'Data');
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildLoadOrderSnapshot(source(['Foo.esp']), instanceDir, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }]);
  });

  it('a directory under overwrite/ sharing a plugin\'s name is not treated as that plugin\'s file', async () => {
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');
    await mkdir(join(instanceDir, 'overwrite', 'Foo.esp'), { recursive: true }); // a directory, not a file
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = await buildLoadOrderSnapshot(source(['Foo.esp']), instanceDir, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }]);
  });

  it('a read failure under overwrite/ other than "missing folder" propagates rather than being swallowed', async () => {
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');
    await writeFile(join(instanceDir, 'overwrite'), 'not a directory'); // readdir on this -> ENOTDIR, not ENOENT
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    await expect(
      buildLoadOrderSnapshot(source(['Foo.esp']), instanceDir, dataFolder, () => Promise.resolve(fakeIndex)),
    ).rejects.toThrow();
  });

  it('maps names to winner paths case-insensitively, never mistaking a nested file for the root-level plugin', async () => {
    const instanceDir = await root();

    const dataFolder = join(instanceDir, 'game', 'Data');
    const fakeIndex = index({
      'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' },
      'bar.esp': { winner: '/mods/B/bar.esp', winnerMod: 'B' },
      'textures/Foo.esp': { winner: '/mods/C/textures/Foo.esp', winnerMod: 'C' },
    });

    const result = await buildLoadOrderSnapshot(
      source(['Foo.esp', 'Bar.esp', 'Fallout4.esm']), instanceDir, dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true },
      { name: 'Bar.esp', path: '/mods/B/bar.esp', origin: 'B', slot: 1, enabled: true, winning: true },
      { name: 'Fallout4.esm', path: join(dataFolder, 'Fallout4.esm'), origin: 'Data', slot: 2, enabled: true, winning: true },
    ]);
  });
});

describe('resolvePluginPaths', () => {
  // A defined-but-empty dataFolder is falsy but not undefined: the fallback branches on
  // definedness, so it still resolves rather than dropping the name.
  it('resolves the Data-folder fallback for an empty-string dataFolder', () => {
    const result = resolvePluginPaths(['Fallout4.esm'], index({}), '');

    expect(result.get('Fallout4.esm')).toBe('Fallout4.esm');
  });

  it('drops a name neither a mod winner nor a dataFolder can resolve', () => {
    const result = resolvePluginPaths(['Fallout4.esm'], index({}), undefined);

    expect(result.has('Fallout4.esm')).toBe(false);
  });
});

describe('originFolder', () => {
  const row = (origin: string, path: string | undefined) =>
    ({ name: 'X.esp', path, origin, slot: null, enabled: false, winning: true });

  it('answers a mod origin with the mod folder its copy sits in', () => {
    const rows = [row('TS Mod', join('/instance', 'mods', 'TS Mod', 'TrueStorms.esp'))];

    expect(originFolder(rows, 'TS Mod')).toBe(join('/instance', 'mods', 'TS Mod'));
  });

  // The reserved origins are the rival the guess `mods/<origin>` got wrong (ADR-0012).
  it('answers the overwrite origin with the overwrite directory, never a folder under mods/', () => {
    const rows = [row('overwrite', join('/instance', 'overwrite', 'Stray.esp'))];

    expect(originFolder(rows, 'overwrite')).toBe(join('/instance', 'overwrite'));
  });

  it('answers the Data origin with the game’s Data folder', () => {
    const rows = [row('Data', join('/game', 'Data', 'Fallout4.esm'))];

    expect(originFolder(rows, 'Data')).toBe(join('/game', 'Data'));
  });

  it('answers undefined for an origin whose only rows are line-only, with no copy on disk', () => {
    expect(originFolder([row('Ghost Mod', undefined)], 'Ghost Mod')).toBeUndefined();
  });

  it('answers undefined for an origin no row carries', () => {
    const rows = [row('TS Mod', join('/instance', 'mods', 'TS Mod', 'TrueStorms.esp'))];

    expect(originFolder(rows, 'Other Mod')).toBeUndefined();
  });

  it('skips a line-only row to reach the same origin’s row that has a copy', () => {
    const rows = [row('TS Mod', undefined), row('TS Mod', join('/instance', 'mods', 'TS Mod', 'B.esp'))];

    expect(originFolder(rows, 'TS Mod')).toBe(join('/instance', 'mods', 'TS Mod'));
  });
});

// What the plugins reconcile is handed instead of walking mods/ a second time: the Mod override
// order's own answer, already resolved on the value.
describe('providedPluginsOf', () => {
  const row = (
    name: string, origin: string, path: string | undefined, winning = true,
  ) => ({ name, path, origin, slot: null, enabled: false, winning });

  it('keys each provided copy by its folded name, at the winning copy\u2019s own on-disk casing', () => {
    const rows = [row('ZETA.esp', 'TS Mod', join('/instance', 'mods', 'TS Mod', 'Zeta.esp'))];

    expect(providedPluginsOf(rows)).toEqual(new Map([['zeta.esp', 'Zeta.esp']]));
  });

  // The overwrite-wins rule is spelled once, where the rows are built: the losing mod copy of a
  // name overwrite/ also provides must not be the name's answer here.
  it('answers a contested name with the winning copy alone', () => {
    const rows = [
      row('A.esp', 'overwrite', join('/instance', 'overwrite', 'A.esp')),
      row('A.esp', 'TS Mod', join('/instance', 'mods', 'TS Mod', 'A.esp'), false),
    ];

    expect(providedPluginsOf(rows)).toEqual(new Map([['a.esp', 'A.esp']]));
  });

  // Data is presence, never provision: the instance did not supply it, so it is no append source.
  it('leaves out a Data-folder copy and a line with no copy at all', () => {
    const rows = [row('Fallout4.esm', 'Data', join('/game', 'Data', 'Fallout4.esm')), row('Ghost.esp', 'Data', undefined)];

    expect(providedPluginsOf(rows)).toEqual(new Map());
  });

  it('leaves out a root-level file that is not a plugin', () => {
    const rows = [row('readme.txt', 'TS Mod', join('/instance', 'mods', 'TS Mod', 'readme.txt'))];

    expect(providedPluginsOf(rows)).toEqual(new Map());
  });
});
