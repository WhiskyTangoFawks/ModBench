import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { GameFolder, ModFolders, OriginFile, PluginEntry } from '../../instanceAdapter/instanceAdapter';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { buildFileConflictIndex, FileConflictLookup, modOrigin, type FileConflictIndex } from '../fileConflictIndex';
import {
  buildLoadOrderRows, loadOrderSnapshotOf, originFiles, providedPluginsOf, type LoadOrderPlugin,
  type LoadOrderPluginLine,
} from '../loadOrderSnapshot';
import type { PluginAddress } from '../../wire/pluginAddress';

type LoadOrderPluginRow = LoadOrderPlugin | LoadOrderPluginLine;
import { present } from '../../ports/present';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

type Provider = { winner: string; winnerMod: string; providers?: string[] };

function index(
  files: Record<string, Provider>,
  filesByMod: Record<string, OriginFile[]> = {},
): FileConflictIndex {
  const lookup = new FileConflictLookup();
  for (const [relativePath, { winner, winnerMod, providers }] of Object.entries(files)) {
    lookup.set({
      relativePath, winner, winnerOrigin: modOrigin(winnerMod), providers: (providers ?? [winnerMod]).map(modOrigin),
    });
  }
  return { files: lookup, filesByMod: new Map(Object.entries(filesByMod)), foldersByMod: new Map() };
}

const DATA_FOLDER = join('/game', 'Data');
const GAME_FOLDER: GameFolder = { kind: 'found', root: '/game', dataFolder: DATA_FOLDER };
const OVERWRITE = join('/instance', 'overwrite');

const lines = (order: string[], enabled: string[] = order): PluginEntry[] =>
  order.map((name) => ({ name, enabled: enabled.includes(name) }));

const runtimeOutput = (relativePath: string): OriginFile => {
  const path = join(OVERWRITE, ...relativePath.split('/'));
  return { relativePath, path, sourcePath: path, excluded: false, excludedByName: false };
};

describe('buildLoadOrderRows, its origins asserted as the literal reserved values of the wire contract rather than the constants the module produces them from', () => {
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

  it('an overridden plugin of a listed name is sent at that slot, enabled as its line says, not winning', () => {
    const fakeIndex = index(
      { 'Shared.esp': { winner: '/mods/A/Shared.esp', winnerMod: 'A', providers: ['A', 'B'] } },
      {
        A: [{ relativePath: 'Shared.esp', path: '/mods/A/Shared.esp', sourcePath: '/mods/A/Shared.esp', excluded: false, excludedByName: false }],
        B: [{ relativePath: 'Shared.esp', path: '/mods/B/Shared.esp', sourcePath: '/mods/B/Shared.esp', excluded: false, excludedByName: false }],
      },
    );

    const result = buildLoadOrderRows(lines(['Other.esp', 'Shared.esp']), fakeIndex, [], GAME_FOLDER);

    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/A/Shared.esp', origin: 'A', slot: 1, enabled: true, winning: true });
    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/B/Shared.esp', origin: 'B', slot: 1, enabled: true, winning: false });
  });

  it('a plugin file no plugins.txt line names is sent with no slot, not enabled, winning if it is the sole provider', () => {
    const fakeIndex = index(
      { 'Stray.esp': { winner: '/mods/C/Stray.esp', winnerMod: 'C' } },
      { C: [{ relativePath: 'Stray.esp', path: '/mods/C/Stray.esp', sourcePath: '/mods/C/Stray.esp', excluded: false, excludedByName: false }, { relativePath: 'textures/x.dds', path: '/mods/C/textures/x.dds', sourcePath: '/mods/C/textures/x.dds', excluded: false, excludedByName: false }] },
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
      { A: [{ relativePath: 'Foo.esp', path: '/mods/A/Foo.esp', sourcePath: '/mods/A/Foo.esp', excluded: false, excludedByName: false }] },
    );

    const result = buildLoadOrderRows(lines(['Foo.esp']), fakeIndex, [runtimeOutput('Foo.esp')], GAME_FOLDER);

    expect(result).toEqual([
      { name: 'Foo.esp', path: join(OVERWRITE, 'Foo.esp'), origin: 'overwrite', slot: 0, enabled: true, winning: true },
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: false },
    ]);
  });

  it('an overwrite/ plugin the mod manager keeps from the game provides nothing, whatever its name carries', () => {
    const excludedFile = { ...runtimeOutput('Foo.esp'), excluded: true };
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const listed = buildLoadOrderRows(lines(['Foo.esp']), fakeIndex, [excludedFile], GAME_FOLDER);
    const unlisted = buildLoadOrderRows(lines([]), index({}), [excludedFile], GAME_FOLDER);

    expect(listed).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', slot: 0, enabled: true, winning: true }]);
    expect(unlisted).toEqual([]);
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

  it('a disabled mod\'s own plugin is sent with no slot, not enabled, not winning', () => {
    const fakeIndex = index({}, { Disabled: [{ relativePath: 'Off.esp', path: '/mods/Disabled/Off.esp', sourcePath: '/mods/Disabled/Off.esp', excluded: false, excludedByName: false }] });

    const result = buildLoadOrderRows(lines(['Listed.esp']), fakeIndex, [], GAME_FOLDER);

    expect(result).toContainEqual(
      { name: 'Off.esp', path: '/mods/Disabled/Off.esp', origin: 'Disabled', slot: null, enabled: false, winning: false },
    );
  });
});

describe('buildLoadOrderRows, a name neither a mod winner nor a game folder found can resolve', () => {
  it('has no path', () => {
    const [row] = buildLoadOrderRows(lines(['Fallout4.esm']), index({}), [], GAME_FOLDER_NOT_FOUND);

    expect(row?.path).toBeUndefined();
  });
});

describe('originFiles', () => {
  const MOD_FOLDER = join('/instance', 'mods', 'TS Mod');
  const value = instanceValueFixture({
    gameFolder: GAME_FOLDER,
    paths: { overwriteDir: OVERWRITE, downloadsDir: undefined, modDirs: new Map([['TS Mod', MOD_FOLDER]]) },
  });
  const fileOf = (origin: string) => present(originFiles(value, origin), `the ${origin} origin's files`).file('plugin-source/x.json');

  it('names a file inside the mod folder the Instance adapter answered for a mod origin', () => {
    expect(fileOf('TS Mod')).toBe(join(MOD_FOLDER, 'plugin-source', 'x.json'));
  });

  it('names a file inside the Overwrite folder for the overwrite origin, a reserved origin never a folder under mods/', () => {
    expect(fileOf('overwrite')).toBe(join(OVERWRITE, 'plugin-source', 'x.json'));
  });

  it('names a file inside the game\u2019s Data folder for the Data origin', () => {
    expect(fileOf('Data')).toBe(join(DATA_FOLDER, 'plugin-source', 'x.json'));
  });

  it('answers nothing for a mod with no folder, and for the Data origin while the game folder is not found', () => {
    expect(originFiles(value, 'Other Mod')).toBeUndefined();
    expect(originFiles({ ...value, gameFolder: GAME_FOLDER_NOT_FOUND }, 'Data')).toBeUndefined();
  });
});

describe('providedPluginsOf, what plugin sync is handed instead of walking mods/ a second time', () => {
  it('keys each provided plugin by its folded name, at its own on-disk name rather than the name of the file a link points at', () => {
    const files = index({ 'Zeta.esp': { winner: join('/store', 'abc123.esp'), winnerMod: 'TS Mod' } }).files;

    expect(providedPluginsOf(files)).toEqual(new Map([['zeta.esp', 'Zeta.esp']]));
  });

  it('answers a name Overwrite provides at Overwrite\u2019s casing, over the mod\u2019s', async () => {
    const overwrite = runtimeOutput('A.esp');
    const modCopy = { ...runtimeOutput('a.esp'), path: join('/instance', 'mods', 'TS Mod', 'a.esp') };
    const adapter = { originFiles: () => Promise.resolve({ origin: 'TS Mod', folder: undefined, files: [modCopy], folders: [], notes: [] }) };

    const { files } = await buildFileConflictIndex([{ kind: 'mod', name: 'TS Mod', enabled: true }], [overwrite], adapter, () => undefined);

    expect(providedPluginsOf(files)).toEqual(new Map([['a.esp', 'A.esp']]));
  });

  it('leaves out a file that is not a plugin, and a plugin below an origin\u2019s root', () => {
    const files = index({
      'readme.txt': { winner: join('/instance', 'mods', 'TS Mod', 'readme.txt'), winnerMod: 'TS Mod' },
      'Optional/B.esp': { winner: join('/instance', 'mods', 'TS Mod', 'Optional', 'B.esp'), winnerMod: 'TS Mod' },
    }).files;

    expect(providedPluginsOf(files)).toEqual(new Map());
  });
});

describe('loadOrderSnapshotOf, the snapshot the sync PUTs, read straight from the value rather than a fresh walk', () => {
  const GAME_FOLDER = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
  const NOT_FOUND = { kind: 'notFound', looked: [], setting: 'modbench.mods.gameDirectory' } as const;
  const row = (name: string, origin: string, slot: number | null, facts: Partial<LoadOrderPlugin> = {}): LoadOrderPlugin =>
    ({ name, path: `/mods/${origin}/${name}`, origin, slot, enabled: true, winning: true, ...facts });
  const folderOf = (mod: string) => `/mo2/mod-folders/${mod}`;
  const modFoldersOf = (...names: string[]): ModFolders => {
    const all = names.map((name) => ({ kind: 'mod' as const, name, path: folderOf(name) }));
    return { all, holding: (entry) => all.find((f) => f.kind === entry.kind && f.name === entry.name) };
  };
  const modFolders = modFoldersOf('ModA', 'ModS', 'ModF', 'ModD', 'ModO', 'ModU', 'ModM', 'ModOff');
  const provider = (origin: string) => origin === 'Data' ? { kind: 'Game' } : { kind: 'Mod', mod: origin, folder: folderOf(origin) };
  const sent = ({ name, path, origin }: LoadOrderPlugin) => ({ name, path, origin, provider: provider(origin) });
  const address = ({ name, origin }: { name: string; origin: string }) => ({ name, origin });
  const outcomeOf = (plugins: LoadOrderPluginRow[], folders: ModFolders = modFolders) =>
    loadOrderSnapshotOf({ plugins, gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine: [], modFolders: folders });
  const snapshotOf = (plugins: LoadOrderPluginRow[], pluginsLoadedWithNoLine: readonly PluginAddress[] = []) => {
    const outcome = loadOrderSnapshotOf({ plugins, gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine, modFolders });
    return outcome !== undefined && 'refusal' in outcome ? undefined : outcome;
  };
  const inGameFolder = (name: string): PluginAddress => ({ name, origin: 'Data' });

  it('is undefined — no put at all — while the game folder\'s plugins cannot be listed, as a snapshot lacking the game\'s masters is not sent', () => {
    expect(loadOrderSnapshotOf({ plugins: [row('a.esp', 'ModA', 0)], gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine: undefined, modFolders }))
      .toBeUndefined();
  });

  it('is undefined — no put at all — when the game folder is not found', () => {
    expect(loadOrderSnapshotOf({ plugins: [row('a.esp', 'ModA', 0)], gameFolder: NOT_FOUND, pluginsLoadedWithNoLine: [], modFolders }))
      .toBeUndefined();
  });

  it('carries the game folder\'s dataFolder, and every plugin with its origin and path', () => {
    const a = row('a.esp', 'ModA', 0);
    const stray = row('stray.esp', 'ModS', null);

    expect(snapshotOf([a, stray])).toMatchObject({ dataFolder: '/game/Data', plugins: [sent(a), sent(stray)] });
  });

  it('sends as active the winning plugin of each enabled line, in line order rather than the value\'s row order, with no disabled or overridden row slipping in', () => {
    const first = row('first.esp', 'ModF', 0);
    const second = row('second.esp', 'ModS', 1);
    const disabled = row('disabled.esp', 'ModD', 2, { enabled: false });
    const overridden = row('second.esp', 'ModO', 1, { winning: false });
    const unlisted = row('unlisted.esp', 'ModU', null, { enabled: false });

    expect(snapshotOf([second, disabled, overridden, unlisted, first])?.active).toEqual([address(first), address(second)]);
  });

  it('sends a disabled mod\'s plugin in plugins, never in active, since it never wins', () => {
    const a = row('a.esp', 'ModA', 0);
    const disabledModPlugin = row('off.esp', 'ModOff', null, { enabled: false, winning: false });

    const snapshot = snapshotOf([a, disabledModPlugin]);

    expect(snapshot?.plugins).toContainEqual(sent(disabledModPlugin));
    expect(snapshot?.active).toEqual([address(a)]);
  });

  it('loads the plugins the game loads with no line first, from the game folder, in the order given', () => {
    const a = row('a.esp', 'ModA', 0);

    const snapshot = snapshotOf([a], [inGameFolder('Master.esm'), inGameFolder('cc.esl')]);

    expect(snapshot?.active).toEqual([
      { name: 'Master.esm', origin: 'Data' }, { name: 'cc.esl', origin: 'Data' }, address(a),
    ]);
    expect(snapshot?.plugins).toContainEqual({ name: 'Master.esm', origin: 'Data', path: join('/game/Data', 'Master.esm'), provider: { kind: 'Game' } });
    expect(snapshot?.loadedWithNoLine).toEqual([{ name: 'Master.esm', origin: 'Data' }, { name: 'cc.esl', origin: 'Data' }]);
  });

  it('sends a plugin the game loads with no line as the mod the Mod override order resolves its name to, once', () => {
    const provided = row('Master.esm', 'ModM', null, { enabled: false });

    const snapshot = snapshotOf([provided], [address(provided)]);

    expect(snapshot?.active).toEqual([address(provided)]);
    expect(snapshot?.loadedWithNoLine).toEqual([address(provided)]);
    expect(snapshot?.plugins).toEqual([sent(provided)]);
  });

  it('places a plugin the game loads with no line once, first whatever its line says, when a line names it too', () => {
    const a = row('a.esp', 'ModA', 0);
    const lined = { ...row('master.esm', 'Data', 1, { enabled: false }), path: join('/game/Data', 'master.esm') };

    const snapshot = snapshotOf([a, lined], [inGameFolder('Master.esm')]);

    expect(snapshot?.active).toEqual([address(lined), address(a)]);
    expect(snapshot?.plugins.filter((p) => p.name.toLowerCase() === 'master.esm')).toHaveLength(1);
  });

  it('names what provides each plugin: its mod with the mod\'s own folder, not the plugin\'s directory, the game for Data, no mod for overwrite', () => {
    const inMod = row('a.esp', 'ModA', 0);
    const inGame = { ...row('b.esp', 'Data', 1), path: '/game/Data/b.esp' };
    const stray = { ...row('c.esp', 'overwrite', null), path: '/instance/overwrite/c.esp' };

    const providers = snapshotOf([inMod, inGame, stray])?.plugins.map((p) => p.provider);

    expect(providers).toEqual([{ kind: 'Mod', mod: 'ModA', folder: '/mo2/mod-folders/ModA' }, { kind: 'Game' }, { kind: 'None' }]);
  });

  it('is a refusal naming each plugin and its mod when no mod folder is the mod\'s, never a snapshot without them', () => {
    expect(outcomeOf([row('a.esp', 'ModA', 0), row('b.esp', 'ModGone', 1), row('c.esp', 'ModGone', null)]))
      .toEqual({ refusal: 'b.esp and c.esp are provided by the mod ModGone, which has no mod folder' });
  });

  it('asks the mod folders which folder is the mod\'s, as the manager matches names, and guesses no case-folding of its own', () => {
    expect(outcomeOf([row('a.esp', 'moda', 0)])).toEqual({ refusal: 'a.esp is provided by the mod moda, which has no mod folder' });
  });

  it('omits a line-only row rather than sending it with path: undefined', () => {
    const a = row('a.esp', 'ModA', 0);
    const unresolved = { name: 'b.esp', path: undefined, origin: 'Data', slot: 1, enabled: true, winning: true };

    const snapshot = snapshotOf([a, unresolved]);

    expect(snapshot?.plugins).toEqual([sent(a)]);
    expect(snapshot?.active).toEqual([address(a)]);
  });
});
