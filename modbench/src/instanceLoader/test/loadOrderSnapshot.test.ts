import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { GameFolder, OriginFile, PluginEntry } from '../../instanceAdapter/instanceAdapter';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { FileConflictLookup, type FileConflictIndex } from '../fileConflictIndex';
import {
  buildLoadOrderRows, loadOrderSnapshotOf, originFiles, originFolder, providedPluginsOf, resolvePluginPaths, type LoadOrderPlugin,
  type LoadOrderPluginLine, type PluginAddress,
} from '../loadOrderSnapshot';

type LoadOrderPluginRow = LoadOrderPlugin | LoadOrderPluginLine;
import { present } from '../../ports/present';

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

const DATA_FOLDER = join('/game', 'Data');
const GAME_FOLDER: GameFolder = { kind: 'found', root: '/game', dataFolder: DATA_FOLDER };
const OVERWRITE = join('/instance', 'overwrite');

const lines = (order: string[], enabled: string[] = order): PluginEntry[] =>
  order.map((name) => ({ name, enabled: enabled.includes(name) }));

// A file the game wrote at run time, as the adapter lists it.
const runtimeOutput = (relativePath: string): OriginFile => ({ relativePath, path: join(OVERWRITE, ...relativePath.split('/')) });

describe('buildLoadOrderRows', () => {
  it('a mod-provided listed plugin is the winning plugin at its plugins.txt slot, with that mod as origin', () => {
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = buildLoadOrderRows(lines(['Foo.esp']), fakeIndex, [], GAME_FOLDER);

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }]);
  });

  it('a vanilla/DLC/CC plugin no mod provides records the reserved Data-directory origin', () => {
    const result = buildLoadOrderRows(lines(['Fallout4.esm']), index({}), [], GAME_FOLDER);

    expect(result).toEqual([{ name: 'Fallout4.esm', path: join(DATA_FOLDER, 'Fallout4.esm'), origin: 'Data', slot: 0, enabled: true, winning: true }]);
  });

  it('sends every plugins.txt line in slot order, the `*` prefix as enabled, matched case-insensitively', () => {
    const fakeIndex = index({ 'On.esp': { winner: '/mods/A/On.esp', winnerMod: 'A' } });

    const result = buildLoadOrderRows(lines(['On.esp', 'Off.esp', 'Mixed.ESP'], ['On.esp', 'Mixed.ESP']), fakeIndex, [], GAME_FOLDER);

    expect(result).toEqual([
      { name: 'On.esp', path: '/mods/A/On.esp', origin: 'A', slot: 0, enabled: true, winning: true },
      { name: 'Off.esp', path: join(DATA_FOLDER, 'Off.esp'), origin: 'Data', slot: 1, enabled: false, winning: true },
      { name: 'Mixed.ESP', path: join(DATA_FOLDER, 'Mixed.ESP'), origin: 'Data', slot: 2, enabled: true, winning: true },
    ]);
  });

  // ADR-0013: the overridden plugin is in the snapshot too — at the name's slot, carrying the
  // line's own `*`, and not winning. Editing registers it beside the winner; only the winner
  // participates.
  it('an overridden plugin of a listed name is sent at that slot, enabled as its line says, not winning', () => {
    const fakeIndex = index(
      { 'Shared.esp': { winner: '/mods/A/Shared.esp', winnerMod: 'A', providers: ['A', 'B'] } },
      {
        A: [{ relativePath: 'Shared.esp', absolutePath: '/mods/A/Shared.esp' }],
        B: [{ relativePath: 'Shared.esp', absolutePath: '/mods/B/Shared.esp' }],
      },
    );

    const result = buildLoadOrderRows(lines(['Other.esp', 'Shared.esp']), fakeIndex, [], GAME_FOLDER);

    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/A/Shared.esp', origin: 'A', slot: 1, enabled: true, winning: true });
    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/B/Shared.esp', origin: 'B', slot: 1, enabled: true, winning: false });
  });

  it('a plugin file no plugins.txt line names is sent with no slot, not enabled, winning if it is the sole provider', () => {
    const fakeIndex = index(
      { 'Stray.esp': { winner: '/mods/C/Stray.esp', winnerMod: 'C' } },
      { C: [{ relativePath: 'Stray.esp', absolutePath: '/mods/C/Stray.esp' }, { relativePath: 'textures/x.dds', absolutePath: '/mods/C/textures/x.dds' }] },
    );

    const result = buildLoadOrderRows(lines(['Listed.esp']), fakeIndex, [], GAME_FOLDER);

    expect(result).toEqual([
      { name: 'Listed.esp', path: join(DATA_FOLDER, 'Listed.esp'), origin: 'Data', slot: 0, enabled: true, winning: true },
      { name: 'Stray.esp', path: '/mods/C/Stray.esp', origin: 'C', slot: null, enabled: false, winning: true },
    ]);
  });

  it('a plugin resolved from overwrite/ wins path and origin over a mod-provided plugin, which is then sent as overridden', () => {
    const fakeIndex = index(
      { 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } },
      { A: [{ relativePath: 'Foo.esp', absolutePath: '/mods/A/Foo.esp' }] },
    );

    const result = buildLoadOrderRows(lines(['Foo.esp']), fakeIndex, [runtimeOutput('Foo.esp')], GAME_FOLDER);

    expect(result).toEqual([
      { name: 'Foo.esp', path: join(OVERWRITE, 'Foo.esp'), origin: 'overwrite', slot: 0, enabled: true, winning: true },
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: false },
    ]);
  });

  it('an unlisted plugin sitting in overwrite/ is sent with no slot, winning-most', () => {
    const result = buildLoadOrderRows(lines([]), index({}), [runtimeOutput('New.esp'), runtimeOutput('notes.txt')], GAME_FOLDER);

    expect(result).toEqual([
      { name: 'New.esp', path: join(OVERWRITE, 'New.esp'), origin: 'overwrite', slot: null, enabled: false, winning: true },
    ]);
  });

  it('never takes a plugin file below overwrite/\'s root for a plugin, listed or not', () => {
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = buildLoadOrderRows(
      lines(['Foo.esp']), fakeIndex, [runtimeOutput('Sub/Foo.esp'), runtimeOutput('Sub/Stray.esp')], GAME_FOLDER,
    );

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }]);
  });

  it('maps names to winner paths case-insensitively, never mistaking a nested file for the root-level plugin', () => {
    const fakeIndex = index({
      'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' },
      'bar.esp': { winner: '/mods/B/bar.esp', winnerMod: 'B' },
      'textures/Foo.esp': { winner: '/mods/C/textures/Foo.esp', winnerMod: 'C' },
    });

    const result = buildLoadOrderRows(lines(['Foo.esp', 'Bar.esp', 'Fallout4.esm']), fakeIndex, [], GAME_FOLDER);

    expect(result).toEqual([
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true },
      { name: 'Bar.esp', path: '/mods/B/bar.esp', origin: 'B', slot: 1, enabled: true, winning: true },
      { name: 'Fallout4.esm', path: join(DATA_FOLDER, 'Fallout4.esm'), origin: 'Data', slot: 2, enabled: true, winning: true },
    ]);
  });
});

describe('resolvePluginPaths', () => {
  it('drops a name neither a mod winner nor a game folder found can resolve', () => {
    const result = resolvePluginPaths(['Fallout4.esm'], index({}), GAME_FOLDER_NOT_FOUND);

    expect(result.has('Fallout4.esm')).toBe(false);
  });
});

describe('originFiles', () => {
  const row = (origin: string, path: string | undefined) =>
    ({ name: 'X.esp', path, origin, slot: null, enabled: false, winning: true });
  const rows = [row('TS Mod', join('/instance', 'mods', 'TS Mod', 'TrueStorms.esp'))];

  it('names a file inside the folder the origin\'s plugin sits in, and holds only what is beneath it', () => {
    const files = present(originFiles(rows, 'TS Mod'), 'the TS Mod origin\'s files');

    expect(files.file('plugin-source/x.json')).toBe(join('/instance', 'mods', 'TS Mod', 'plugin-source', 'x.json'));
    expect(files.holds(join('/instance', 'mods', 'TS Mod', 'plugin-source', 'x.json'))).toBe(true);
    expect(files.holds(join('/instance', 'mods', 'Other', 'x.json'))).toBe(false);
  });

  it('answers nothing for an origin with no plugin file on disk', () => {
    expect(originFiles(rows, 'Missing')).toBeUndefined();
  });
});

describe('originFolder', () => {
  const row = (origin: string, path: string | undefined) =>
    ({ name: 'X.esp', path, origin, slot: null, enabled: false, winning: true });

  it('answers a mod origin with the mod folder its plugin sits in', () => {
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

  it('answers undefined for an origin whose only rows are line-only, with no plugin file on disk', () => {
    expect(originFolder([row('Ghost Mod', undefined)], 'Ghost Mod')).toBeUndefined();
  });

  it('answers undefined for an origin no row carries', () => {
    const rows = [row('TS Mod', join('/instance', 'mods', 'TS Mod', 'TrueStorms.esp'))];

    expect(originFolder(rows, 'Other Mod')).toBeUndefined();
  });

  it('skips a line-only row to reach the same origin’s row that has a plugin file', () => {
    const rows = [row('TS Mod', undefined), row('TS Mod', join('/instance', 'mods', 'TS Mod', 'B.esp'))];

    expect(originFolder(rows, 'TS Mod')).toBe(join('/instance', 'mods', 'TS Mod'));
  });
});

// What plugin sync is handed instead of walking mods/ a second time: the Mod override
// order's own answer, already resolved on the value.
describe('providedPluginsOf', () => {
  const row = (
    name: string, origin: string, path: string | undefined, winning = true,
  ) => ({ name, path, origin, slot: null, enabled: false, winning });

  it('keys each provided plugin by its folded name, at the winning plugin\u2019s own on-disk casing', () => {
    const rows = [row('ZETA.esp', 'TS Mod', join('/instance', 'mods', 'TS Mod', 'Zeta.esp'))];

    expect(providedPluginsOf(rows)).toEqual(new Map([['zeta.esp', 'Zeta.esp']]));
  });

  // The overwrite-wins rule is spelled once, where the rows are built: the overridden mod plugin of
  // a name overwrite/ also provides must not be the name's answer here.
  it('answers a contested name with the winning plugin alone', () => {
    const rows = [
      row('A.esp', 'overwrite', join('/instance', 'overwrite', 'A.esp')),
      row('A.esp', 'TS Mod', join('/instance', 'mods', 'TS Mod', 'A.esp'), false),
    ];

    expect(providedPluginsOf(rows)).toEqual(new Map([['a.esp', 'A.esp']]));
  });

  // Data is presence, never provision: the instance did not supply it, so it is no append source.
  it('leaves out a Data-folder plugin and a line with no plugin file at all', () => {
    const rows = [row('Fallout4.esm', 'Data', join('/game', 'Data', 'Fallout4.esm')), row('Ghost.esp', 'Data', undefined)];

    expect(providedPluginsOf(rows)).toEqual(new Map());
  });

  it('leaves out a root-level file that is not a plugin', () => {
    const rows = [row('readme.txt', 'TS Mod', join('/instance', 'mods', 'TS Mod', 'readme.txt'))];

    expect(providedPluginsOf(rows)).toEqual(new Map());
  });
});

// ADR-0013: the snapshot the sync PUTs, read straight from the value rather than a fresh walk.
describe('loadOrderSnapshotOf', () => {
  const GAME_FOLDER = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
  const NOT_FOUND = { kind: 'notFound', looked: [], setting: 'modbench.mods.gameDirectory' } as const;
  const row = (name: string, origin: string, slot: number | null, facts: Partial<LoadOrderPlugin> = {}): LoadOrderPlugin =>
    ({ name, path: `/mods/${origin}/${name}`, origin, slot, enabled: true, winning: true, ...facts });
  const sent = ({ name, path, origin }: LoadOrderPlugin) => ({ name, path, origin });
  const address = ({ name, origin }: { name: string; origin: string }) => ({ name, origin });
  const snapshotOf = (plugins: LoadOrderPluginRow[], pluginsLoadedWithNoLine: readonly PluginAddress[] = []) =>
    loadOrderSnapshotOf({ plugins, gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine });
  const inGameFolder = (name: string): PluginAddress => ({ name, origin: 'Data' });

  // principles.md, Never silently wrong: a snapshot lacking the game's masters is not sent.
  it('is undefined — no put at all — while the game folder\'s plugins cannot be listed', () => {
    expect(loadOrderSnapshotOf({ plugins: [row('a.esp', 'ModA', 0)], gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine: undefined }))
      .toBeUndefined();
  });

  it('is undefined — no put at all — when the game folder is not found', () => {
    expect(loadOrderSnapshotOf({ plugins: [row('a.esp', 'ModA', 0)], gameFolder: NOT_FOUND, pluginsLoadedWithNoLine: [] }))
      .toBeUndefined();
  });

  it('carries the game folder\'s dataFolder, and every plugin with its origin and path', () => {
    const a = row('a.esp', 'ModA', 0);
    const stray = row('stray.esp', 'ModS', null);

    expect(snapshotOf([a, stray])).toMatchObject({ dataFolder: '/game/Data', plugins: [sent(a), sent(stray)] });
  });

  // ADR-0013 invariant 3: Mod Management alone decides the active plugins. The rivals: the value's
  // row order standing in for the line order, and a disabled or overridden row slipping in.
  it('sends as active the winning plugin of each enabled line, in line order', () => {
    const first = row('first.esp', 'ModF', 0);
    const second = row('second.esp', 'ModS', 1);
    const disabled = row('disabled.esp', 'ModD', 2, { enabled: false });
    const overridden = row('second.esp', 'ModO', 1, { winning: false });
    const unlisted = row('unlisted.esp', 'ModU', null, { enabled: false });

    expect(snapshotOf([second, disabled, overridden, unlisted, first])?.active).toEqual([address(first), address(second)]);
  });

  it('loads the plugins the game loads with no line first, from the game folder, in the order given', () => {
    const a = row('a.esp', 'ModA', 0);

    const snapshot = snapshotOf([a], [inGameFolder('Master.esm'), inGameFolder('cc.esl')]);

    expect(snapshot?.active).toEqual([
      { name: 'Master.esm', origin: 'Data' }, { name: 'cc.esl', origin: 'Data' }, address(a),
    ]);
    expect(snapshot?.plugins).toContainEqual({ name: 'Master.esm', origin: 'Data', path: join('/game/Data', 'Master.esm') });
    expect(snapshot?.loadedWithNoLine).toEqual([{ name: 'Master.esm', origin: 'Data' }, { name: 'cc.esl', origin: 'Data' }]);
  });

  // The file the game reads is the one the Mod override order resolves the name to.
  it('sends a plugin the game loads with no line as the mod that provides it, once', () => {
    const provided = row('Master.esm', 'ModM', null, { enabled: false });

    const snapshot = snapshotOf([provided], [address(provided)]);

    expect(snapshot?.active).toEqual([address(provided)]);
    expect(snapshot?.loadedWithNoLine).toEqual([address(provided)]);
    expect(snapshot?.plugins).toEqual([sent(provided)]);
  });

  // The game loads it first whatever its line says, and one file is never active twice.
  it('places a plugin the game loads with no line once, first, when a line names it too', () => {
    const a = row('a.esp', 'ModA', 0);
    const lined = { ...row('master.esm', 'Data', 1, { enabled: false }), path: join('/game/Data', 'master.esm') };

    const snapshot = snapshotOf([a, lined], [inGameFolder('Master.esm')]);

    expect(snapshot?.active).toEqual([address(lined), address(a)]);
    expect(snapshot?.plugins.filter((p) => p.name.toLowerCase() === 'master.esm')).toHaveLength(1);
  });

  // Rival: casting the union blind and sending `path: undefined` to the backend.
  it('omits a line-only row rather than sending it with path: undefined', () => {
    const a = row('a.esp', 'ModA', 0);
    const unresolved = { name: 'b.esp', path: undefined, origin: 'Data', slot: 1, enabled: true, winning: true };

    const snapshot = snapshotOf([a, unresolved]);

    expect(snapshot?.plugins).toEqual([sent(a)]);
    expect(snapshot?.active).toEqual([address(a)]);
  });
});
