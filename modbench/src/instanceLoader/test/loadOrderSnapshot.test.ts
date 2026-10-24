import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { DataFolderPlugins, FileRead, FileStamp, GameFolder, ModFolders, OriginFile, PluginEntry } from '../../instanceAdapter/instanceAdapter';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { buildFileConflictIndex, FileConflictLookup, modOrigin, type FileConflictIndex } from '../fileConflictIndex';
import {
  buildLoadOrderRows, listedArchivesNothingHolds, loadOrderSnapshotOf, pluginsLoadedWithNoLineOf, sourceFiles, type PluginWithNoLine, stampedSnapshot,
  type ArchiveSources,
  type LoadOrderPlugin, type LoadOrderPluginLine,
} from '../loadOrderSnapshot';

type LoadOrderPluginRow = LoadOrderPlugin | LoadOrderPluginLine;
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { fileIn } from '../../test/fakeInstanceAdapter';

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

const inDataFolder = (...names: string[]): DataFolderPlugins => ({ kind: 'listed', names: new Set(names) });
const NO_DATA_PLUGINS = inDataFolder();
const DATA_FOLDER = join('/game', 'Data');
const GAME_FOLDER: GameFolder = { kind: 'found', root: '/game', dataFolder: DATA_FOLDER };
const OVERWRITE = '/instance/overwrite';

const lines = (order: string[], enabled: string[] = order): PluginEntry[] =>
  order.map((name) => ({ name, enabled: enabled.includes(name) }));

const builtIndex = (filesByMod: Record<string, OriginFile[]>, overwrite: readonly OriginFile[]): FileConflictIndex =>
  buildFileConflictIndex(
    Object.keys(filesByMod).map((name) => ({ kind: 'mod', name, enabled: true })),
    overwrite,
    new Map(Object.entries(filesByMod).map(([name, files]) => [name, { origin: name, folder: undefined, files, folders: [], notes: [] }])),
  );

describe('the load order rows, each origin the wire contract\'s literal reserved value', () => {
  it('a mod called Data and a mod called overwrite keep their own origin, apart from the game folder and Overwrite', () => {
    const fakeIndex = index({
      'D.esp': { winner: '/mods/Data/D.esp', winnerMod: 'Data' },
      'O.esp': { winner: '/mods/overwrite/O.esp', winnerMod: 'overwrite' },
    });

    const result = buildLoadOrderRows(lines(['D.esp', 'O.esp', 'V.esm']), fakeIndex, [], GAME_FOLDER, inDataFolder('V.esm'));

    expect(result.map((p) => p.origin)).toEqual(['Data', 'overwrite', 'Data/']);
  });

  it('sends every plugins.txt line in line order, the `*` prefix as enabled, matched case-insensitively', () => {
    const fakeIndex = index({ 'On.esp': { winner: '/mods/A/On.esp', winnerMod: 'A' } });

    const result = buildLoadOrderRows(lines(['On.esp', 'Off.esp', 'Mixed.ESP'], ['On.esp', 'Mixed.ESP']), fakeIndex, [], GAME_FOLDER, inDataFolder('Off.esp', 'Mixed.ESP'));

    expect(result).toEqual([
      { name: 'On.esp', path: '/mods/A/On.esp', origin: 'A', line: 0, enabled: true, winning: true },
      { name: 'Off.esp', path: join(DATA_FOLDER, 'Off.esp'), origin: 'Data/', line: 1, enabled: false, winning: true },
      { name: 'Mixed.ESP', path: join(DATA_FOLDER, 'Mixed.ESP'), origin: 'Data/', line: 2, enabled: true, winning: true },
    ]);
  });

  it('an overridden plugin of a listed name is sent at that line, enabled as its line says, not winning', () => {
    const fakeIndex = index(
      { 'Shared.esp': { winner: '/mods/A/Shared.esp', winnerMod: 'A', providers: ['A', 'B'] } },
      {
        A: [fileIn('/mods/A', 'Shared.esp')],
        B: [fileIn('/mods/B', 'Shared.esp')],
      },
    );

    const result = buildLoadOrderRows(lines(['Other.esp', 'Shared.esp']), fakeIndex, [], GAME_FOLDER, NO_DATA_PLUGINS);

    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/A/Shared.esp', origin: 'A', line: 1, enabled: true, winning: true });
    expect(result).toContainEqual({ name: 'Shared.esp', path: '/mods/B/Shared.esp', origin: 'B', line: 1, enabled: true, winning: false });
  });

  it('a plugin file no plugins.txt line names is sent with no line, not enabled, winning if it is the sole provider', () => {
    const fakeIndex = index(
      { 'Stray.esp': { winner: '/mods/C/Stray.esp', winnerMod: 'C' } },
      { C: [fileIn('/mods/C', 'Stray.esp'), fileIn('/mods/C', 'textures/x.dds')] },
    );

    const result = buildLoadOrderRows(lines(['Listed.esp']), fakeIndex, [], GAME_FOLDER, inDataFolder('Listed.esp'));

    expect(result).toEqual([
      { name: 'Listed.esp', path: join(DATA_FOLDER, 'Listed.esp'), origin: 'Data/', line: 0, enabled: true, winning: true },
      { name: 'Stray.esp', path: '/mods/C/Stray.esp', origin: 'C', line: null, enabled: false, winning: true },
    ]);
  });

  it('a plugin resolved from overwrite/ wins path and origin over a mod-provided plugin, which is then sent as overridden', () => {
    const overwrite = [fileIn(OVERWRITE, 'Foo.esp')];

    const result = buildLoadOrderRows(lines(['Foo.esp']), builtIndex({ A: [fileIn('/mods/A', 'Foo.esp')] }, overwrite), overwrite, GAME_FOLDER, NO_DATA_PLUGINS);

    expect(result).toEqual([
      { name: 'Foo.esp', path: '/instance/overwrite/Foo.esp', origin: 'overwrite/', line: 0, enabled: true, winning: true },
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', line: 0, enabled: true, winning: false },
    ]);
  });

  it('an overwrite/ plugin the mod manager keeps from the game provides nothing, whatever its name carries', () => {
    const excludedFile = { ...fileIn(OVERWRITE, 'Foo.esp'), excluded: true };
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const listed = buildLoadOrderRows(lines(['Foo.esp']), fakeIndex, [excludedFile], GAME_FOLDER, NO_DATA_PLUGINS);
    const unlisted = buildLoadOrderRows(lines([]), index({}), [excludedFile], GAME_FOLDER, NO_DATA_PLUGINS);

    expect(listed).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', line: 0, enabled: true, winning: true }]);
    expect(unlisted).toEqual([]);
  });

  it('an unlisted plugin sitting in overwrite/ is sent with no line, winning-most', () => {
    const overwrite = [fileIn(OVERWRITE, 'New.esp'), fileIn(OVERWRITE, 'notes.txt')];

    const result = buildLoadOrderRows(lines([]), builtIndex({}, overwrite), overwrite, GAME_FOLDER, NO_DATA_PLUGINS);

    expect(result).toEqual([
      { name: 'New.esp', path: '/instance/overwrite/New.esp', origin: 'overwrite/', line: null, enabled: false, winning: true },
    ]);
  });

  it('never takes a plugin file below overwrite/\'s root for a plugin, listed or not', () => {
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } });

    const result = buildLoadOrderRows(
      lines(['Foo.esp']), fakeIndex, [fileIn(OVERWRITE, 'Sub/Foo.esp'), fileIn(OVERWRITE, 'Sub/Stray.esp')], GAME_FOLDER, NO_DATA_PLUGINS,
    );

    expect(result).toEqual([{ name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', line: 0, enabled: true, winning: true }]);
  });

  it('maps a line to its winner without case, at the winning file\'s spelling, never mistaking a nested file for the root-level plugin', () => {
    const fakeIndex = index({
      'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' },
      'bar.esp': { winner: '/mods/B/bar.esp', winnerMod: 'B' },
      'textures/Foo.esp': { winner: '/mods/C/textures/Foo.esp', winnerMod: 'C' },
    });

    const result = buildLoadOrderRows(lines(['Foo.esp', 'Bar.esp', 'Fallout4.esm']), fakeIndex, [], GAME_FOLDER, inDataFolder('Fallout4.esm'));

    expect(result).toEqual([
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', line: 0, enabled: true, winning: true },
      { name: 'bar.esp', path: '/mods/B/bar.esp', origin: 'B', line: 1, enabled: true, winning: true },
      { name: 'Fallout4.esm', path: join(DATA_FOLDER, 'Fallout4.esm'), origin: 'Data/', line: 2, enabled: true, winning: true },
    ]);
  });

  it('a disabled mod\'s own plugin is sent with no line, not enabled, not winning', () => {
    const fakeIndex = index({}, { Disabled: [fileIn('/mods/Disabled', 'Off.esp')] });

    const result = buildLoadOrderRows(lines(['Listed.esp']), fakeIndex, [], GAME_FOLDER, NO_DATA_PLUGINS);

    expect(result).toContainEqual(
      { name: 'Off.esp', path: '/mods/Disabled/Off.esp', origin: 'Disabled', line: null, enabled: false, winning: false },
    );
  });
});

describe('the load order rows of plugins whose names or origins differ only in case', () => {
  it('sends both files of one mod, the line naming the one the Mod override order resolves the name to, at that file\'s spelling', () => {
    const fakeIndex = index({ 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A' } }, { A: [fileIn('/mods/A', 'Foo.esp'), fileIn('/mods/A', 'foo.esp')] });

    const result = buildLoadOrderRows(lines(['FOO.esp']), fakeIndex, [], GAME_FOLDER, NO_DATA_PLUGINS);

    expect(result).toEqual([
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', line: 0, enabled: true, winning: true },
      { name: 'foo.esp', path: '/mods/A/foo.esp', origin: 'A', line: 0, enabled: true, winning: false },
    ]);
  });

  it('sends the copy of a mod whose name differs only in case from the winning mod\'s, not winning', () => {
    const fakeIndex = index(
      { 'Foo.esp': { winner: '/mods/A/Foo.esp', winnerMod: 'A', providers: ['A', 'a'] } },
      { A: [fileIn('/mods/A', 'Foo.esp')], a: [fileIn('/mods/a', 'Foo.esp')] },
    );

    const result = buildLoadOrderRows(lines(['Foo.esp']), fakeIndex, [], GAME_FOLDER, NO_DATA_PLUGINS);

    expect(result).toEqual([
      { name: 'Foo.esp', path: '/mods/A/Foo.esp', origin: 'A', line: 0, enabled: true, winning: true },
      { name: 'Foo.esp', path: '/mods/a/Foo.esp', origin: 'a', line: 0, enabled: true, winning: false },
    ]);
  });

  it('sends both of overwrite/\'s files, the one the Mod override order resolves the name to winning', () => {
    const files = [fileIn(OVERWRITE, 'New.esp'), fileIn(OVERWRITE, 'new.esp')];

    const result = buildLoadOrderRows(lines([]), builtIndex({}, files), files, GAME_FOLDER, NO_DATA_PLUGINS);

    expect(result).toEqual([
      { name: 'New.esp', path: '/instance/overwrite/New.esp', origin: 'overwrite/', line: null, enabled: false, winning: true },
      { name: 'new.esp', path: '/instance/overwrite/new.esp', origin: 'overwrite/', line: null, enabled: false, winning: false },
    ]);
  });

  it('names a Data folder plugin a line names in other case by the file\'s spelling, at the path of that file', () => {
    const result = buildLoadOrderRows(lines(['foo.esp']), index({}), [], GAME_FOLDER, inDataFolder('Foo.esp'));

    expect(result).toEqual([{ name: 'Foo.esp', path: join(DATA_FOLDER, 'Foo.esp'), origin: 'Data/', line: 0, enabled: true, winning: true }]);
  });

  it('names a Data folder plugin two lines name in different case once per line, by the file\'s spelling', () => {
    const result = buildLoadOrderRows(lines(['FALLOUT4.ESM', 'fallout4.esm']), index({}), [], GAME_FOLDER, inDataFolder('Fallout4.esm'));

    expect(result.map((p) => [p.name, p.origin, p.line])).toEqual([['Fallout4.esm', 'Data/', 0], ['Fallout4.esm', 'Data/', 1]]);
  });

  it('sends both Data folder files a line names, the one spelled as the line winning', () => {
    const result = buildLoadOrderRows(lines(['foo.esp']), index({}), [], GAME_FOLDER, inDataFolder('Foo.esp', 'foo.esp'));

    expect(result.map((p) => [p.name, p.line, p.winning])).toEqual([['foo.esp', 0, true], ['Foo.esp', 0, false]]);
  });
});

describe('the plugins the game loads with no line', () => {
  it('names a game master a line names in the game folder at that line\'s plugin\'s spelling', () => {
    const lined = { name: 'master.esm', path: join(DATA_FOLDER, 'master.esm'), origin: 'Data/', line: 0, enabled: true, winning: true };

    expect(pluginsLoadedWithNoLineOf(['Master.esm'], inDataFolder('master.esm'), [lined], GAME_FOLDER))
      .toEqual([{ name: 'master.esm', origin: 'Data/', path: join(DATA_FOLDER, 'master.esm') }]);
  });

  it('names a game master the Data folder spells otherwise by the folder\'s spelling', () => {
    expect(pluginsLoadedWithNoLineOf(['Master.esm'], inDataFolder('MASTER.ESM'), [], GAME_FOLDER))
      .toEqual([{ name: 'MASTER.ESM', origin: 'Data/', path: join(DATA_FOLDER, 'MASTER.ESM') }]);
  });

  it('names each of two Data folder files that differ only in case', () => {
    expect(pluginsLoadedWithNoLineOf(['Master.esm'], inDataFolder('Master.esm', 'master.esm'), [], GAME_FOLDER))
      .toEqual([
        { name: 'Master.esm', origin: 'Data/', path: join(DATA_FOLDER, 'Master.esm') },
        { name: 'master.esm', origin: 'Data/', path: join(DATA_FOLDER, 'master.esm') },
      ]);
  });

  it('names a game master a mod provides at that mod\'s file', () => {
    const provided = { name: 'Master.esm', path: '/mods/A/Master.esm', origin: 'A', line: 0, enabled: true, winning: true };

    expect(pluginsLoadedWithNoLineOf(['Master.esm'], inDataFolder('Master.esm'), [provided], GAME_FOLDER))
      .toEqual([{ name: 'Master.esm', origin: 'A', path: '/mods/A/Master.esm' }]);
  });

  it('names none while the game folder is not found', () => {
    expect(pluginsLoadedWithNoLineOf(['Master.esm'], inDataFolder('Master.esm'), [], GAME_FOLDER_NOT_FOUND)).toBeUndefined();
  });
});

describe('the load order row of a name no mod winner provides and no game folder holds', () => {
  it.each([['not found', GAME_FOLDER_NOT_FOUND], ['found without it', GAME_FOLDER]])('has no path, the game folder %s', (_, gameFolder) => {
    const [row] = buildLoadOrderRows(lines(['Fallout4.esm']), index({}), [], gameFolder, NO_DATA_PLUGINS);

    expect(row?.path).toBeUndefined();
  });
});

describe('the source files of an origin', () => {
  const SOURCE_FOLDER = join('/instance', 'source', 'TS Mod');
  const value = instanceValueFixture({
    gameFolder: GAME_FOLDER,
    paths: {
      overwriteDir: OVERWRITE, downloadsDir: undefined, modDirs: new Map([['TS Mod', join('/instance', 'mods', 'TS Mod')]]),
      sourceDirs: new Map([['TS Mod', SOURCE_FOLDER], ['Data', join('/instance', 'source', 'Data')], ['overwrite', join('/instance', 'source', 'overwrite')]]),
    },
  });

  it.each([
    ['a file inside the source folder the Instance adapter answered for a mod origin, not its mod folder', 'TS Mod', join(SOURCE_FOLDER, 'plugin-source', 'x.json')],
    ['a file inside the source folder of a mod called Data, never the game folder', 'Data', join('/instance', 'source', 'Data', 'plugin-source', 'x.json')],
    ['a file inside the source folder of a mod called overwrite, never Overwrite', 'overwrite', join('/instance', 'source', 'overwrite', 'plugin-source', 'x.json')],
    ['nothing for a mod with no source folder', 'Other Mod', undefined],
    ['nothing for Overwrite, which is no mod', 'overwrite/', undefined],
    ['nothing for the game folder, which is no mod', 'Data/', undefined],
  ])('names %s', (_case, origin, expected) => {
    expect(sourceFiles(value, origin)?.file('plugin-source/x.json')).toBe(expected);
  });
});

describe('the snapshot the sync PUTs, read straight from the value rather than a fresh walk', () => {
  const row = (name: string, origin: string, line: number | null, facts: Partial<LoadOrderPlugin> = {}): LoadOrderPlugin =>
    ({ name, path: `/mods/${origin}/${name}`, origin, line, enabled: true, winning: true, ...facts });
  const folderOf = (mod: string) => `/mo2/mod-folders/${mod}`;
  const modFoldersOf = (...names: string[]): ModFolders => {
    const all = names.map((name) => ({ kind: 'mod' as const, name, path: folderOf(name), modName: name }));
    return { all, holding: (entry) => all.find((f) => f.kind === entry.kind && f.name === entry.name) };
  };
  const modFolders = modFoldersOf('ModA', 'ModS', 'ModF', 'ModD', 'ModO', 'ModU', 'ModM', 'ModOff');
  const sourceDirOf = (mod: string) => `/mo2/source/${mod}`;
  const sourceDirs = new Map(modFolders.all.map(({ name }) => [name, sourceDirOf(name)]));
  const A_SENT = {
    name: 'a.esp', path: '/mods/ModA/a.esp', origin: 'ModA', line: 0, lineNamesIt: true, archives: [], stringsFiles: [],
    provider: { kind: 'Mod', mod: 'ModA', folder: '/mo2/mod-folders/ModA', sourceFolder: '/mo2/source/ModA' },
  };
  const address = ({ name, origin }: { name: string; origin: string }) => ({ name, origin });
  const NO_ARCHIVES: ArchiveSources = {
    gameRelease: 'Fallout4', listed: [], inData: { kind: 'listed', archives: [], stringsFiles: [] }, files: new FileConflictLookup(),
    filesByOrigin: new Map(),
  };
  const NO_MODLIST = { mods: [], metadataFiles: ['meta.ini'], statCache: '/mo2/stat-cache' };
  const outcomeOf = (plugins: LoadOrderPluginRow[], folders: ModFolders = modFolders) =>
    loadOrderSnapshotOf({ plugins, gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine: [], modFolders: folders, sourceDirs, places: [], modlist: NO_MODLIST, archives: NO_ARCHIVES });
  const snapshotOf = (plugins: LoadOrderPluginRow[], pluginsLoadedWithNoLine: readonly PluginWithNoLine[] = [], archives = NO_ARCHIVES) => {
    const outcome = loadOrderSnapshotOf({ plugins, gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine, modFolders, sourceDirs, places: [], modlist: NO_MODLIST, archives });
    return outcome !== undefined && 'refusal' in outcome ? undefined : outcome;
  };
  const inGameFolder = (name: string): PluginWithNoLine => ({ name, origin: 'Data/', path: join('/game/Data', name) });

  it('carries the release of the reading it was built from', () => {
    expect(snapshotOf([], [], { ...NO_ARCHIVES, gameRelease: 'Fallout4VR' })?.gameRelease).toBe('Fallout4VR');
  });

  it.each<[string, Partial<Parameters<typeof loadOrderSnapshotOf>[0]>]>([
    ['the game folder\'s plugins cannot be listed, as a snapshot lacking the game\'s masters is not sent', { pluginsLoadedWithNoLine: undefined }],
    ['the game folder is not found', { gameFolder: GAME_FOLDER_NOT_FOUND }],
    ['the game folder\'s archives cannot be listed, as a snapshot lacking the game\'s strings is not sent', { archives: { ...NO_ARCHIVES, inData: { kind: 'unreadable', reason: 'EACCES' } } }],
  ])('is undefined — no put at all — while %s', (_, withheld) => {
    expect(loadOrderSnapshotOf({
      plugins: [row('a.esp', 'ModA', 0)], gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine: [], modFolders, sourceDirs, places: [], modlist: NO_MODLIST, archives: NO_ARCHIVES, ...withheld,
    })).toBeUndefined();
  });

  describe('the archives the game loads and the strings files it reads', () => {
    const winners = (entries: Record<string, string>): FileConflictLookup => {
      const lookup = new FileConflictLookup();
      for (const [relativePath, mod] of Object.entries(entries)) {
        lookup.set({ relativePath, winner: `/mods/${mod}/${relativePath}`, winnerOrigin: modOrigin(mod), providers: [modOrigin(mod)] });
      }
      return lookup;
    };
    const inData = (archives: string[], stringsFiles: string[] = []): ArchiveSources['inData'] => ({ kind: 'listed', archives, stringsFiles });

    it('loads the archives the INIs list in their order, then each active plugin\'s in load order, each from the mod the Mod override order resolves it to, else the game folder', () => {
      const a = row('A.esp', 'ModA', 0);
      const archives: ArchiveSources = {
        ...NO_ARCHIVES,
        listed: ['Fallout4 - Startup.ba2', 'fallout4 - interface.ba2'],
        inData: inData(['Fallout4 - Interface.ba2', 'Fallout4 - Startup.ba2', 'DLCRobot - Main.ba2', 'Unloaded - Main.ba2']),
        files: winners({ 'Fallout4 - Interface.ba2': 'Interface Fix', 'A - Textures.ba2': 'ModA', 'A - Main.ba2': 'ModA', 'Nested/A.ba2': 'ModA' }),
      };

      expect(snapshotOf([a], [inGameFolder('DLCRobot.esm')], archives)?.archives).toEqual([
        join('/game/Data', 'Fallout4 - Startup.ba2'), '/mods/Interface Fix/Fallout4 - Interface.ba2', join('/game/Data', 'DLCRobot - Main.ba2'),
        '/mods/ModA/A - Main.ba2', '/mods/ModA/A - Textures.ba2',
      ]);
    });

    it('loads an archive once, where it first loads, and leaves out a listed archive nothing holds', () => {
      const a = row('A.esp', 'ModA', 0);
      const archives: ArchiveSources = { ...NO_ARCHIVES, listed: ['A - Main.ba2', 'Gone.ba2'], files: winners({ 'A - Main.ba2': 'ModA' }) };

      expect(snapshotOf([a], [], archives)?.archives).toEqual(['/mods/ModA/A - Main.ba2']);
    });

    it.each([
      ['the game folder holds', 'fallout4 - startup.ba2', []],
      ['a mod holds', 'A - Main.ba2', []],
      ['nothing holds', 'Gone.ba2', ['Gone.ba2']],
    ])('names a listed archive %s as nothing holding it only when nothing does', (_holder, listed, nothingHolds) => {
      const archives: ArchiveSources = {
        ...NO_ARCHIVES, listed: [listed], inData: inData(['Fallout4 - Startup.ba2']), files: winners({ 'A - Main.ba2': 'ModA', 'Nested/Gone.ba2': 'ModA' }),
      };

      expect(listedArchivesNothingHolds(archives)).toEqual(nothingHolds);
    });

    it('reads every loose strings file at the path the Mod override order resolves it to, a mod\'s over the game folder\'s', () => {
      const archives: ArchiveSources = {
        ...NO_ARCHIVES,
        inData: inData([], ['Strings/Fallout4_en.STRINGS', 'Strings/DLCRobot_en.STRINGS']),
        files: winners({ 'strings/fallout4_en.strings': 'Translation', 'Strings/Readme.txt': 'Translation', 'Nested/Strings/A_en.STRINGS': 'ModA' }),
      };

      expect(snapshotOf([], [], archives)?.stringsFiles).toEqual(['/mods/Translation/strings/fallout4_en.strings', join('/game/Data', 'Strings/DLCRobot_en.STRINGS')]);
    });
  });

  it('hands each copy, loaded or not, the strings files beside it: loose in its strings folder, and the archives named for it at its folder\'s root', () => {
    const file = (origin: string, relativePath: string, excluded = false): OriginFile =>
      ({ relativePath, path: `/mods/${origin}/${relativePath}`, sourcePath: `/store/${origin}/${relativePath}`, excluded, markedExcluded: excluded, includedPath: relativePath });
    const archives: ArchiveSources = {
      ...NO_ARCHIVES,
      inData: { kind: 'listed', archives: ['D - Main.ba2', 'A - Main.ba2'], stringsFiles: ['Strings/D_en.STRINGS', 'Strings/A_en.STRINGS'] },
      filesByOrigin: new Map([
        ['ModA', [
          file('ModA', 'Strings/A_en.STRINGS'), file('ModA', 'strings/a_en.DLSTRINGS'), file('ModA', 'Strings/A_en.ILSTRINGS', true),
          file('ModA', 'Strings/B_en.STRINGS'), file('ModA', 'Nested/Strings/A_en.ILSTRINGS'), file('ModA', 'A - Textures.ba2'),
          file('ModA', 'A - Main.ba2'), file('ModA', 'B - Main.ba2'), file('ModA', 'Nested/A - Main.ba2'),
        ]],
        ['ModO', [file('ModO', 'Strings/A_en.STRINGS')]],
      ]),
    };

    const handed = snapshotOf([row('A.esp', 'ModA', 0), row('A.esp', 'ModO', 0, { winning: false }), row('D.esm', 'Data/', null)], [], archives)
      ?.plugins.map(({ origin, archives: own, stringsFiles }) => ({ origin, archives: own, stringsFiles }));

    expect(handed).toEqual([
      {
        origin: 'ModA',
        archives: ['/store/ModA/A - Main.ba2', '/store/ModA/A - Textures.ba2'],
        stringsFiles: ['/store/ModA/Strings/A_en.STRINGS', '/store/ModA/strings/a_en.DLSTRINGS'],
      },
      { origin: 'ModO', archives: [], stringsFiles: ['/store/ModO/Strings/A_en.STRINGS'] },
      { origin: 'Data/', archives: [join('/game/Data', 'D - Main.ba2')], stringsFiles: [join('/game/Data', 'Strings/D_en.STRINGS')] },
    ]);
  });

  it('stamps every archive and strings file it hands, the game\'s and each copy\'s, by the stamp read at its own path, reading each path once', async () => {
    const asked: string[] = [];
    const stampOf = (path: string): Promise<FileRead<FileStamp>> => {
      asked.push(path);
      return Promise.resolve(path.endsWith('.STRINGS')
        ? { kind: 'unreadable', reason: `EACCES ${path}` }
        : { kind: 'read', answer: { size: BigInt(path.length), modifiedNs: 1n, changedNs: 2n } });
    };
    const value: Parameters<typeof stampedSnapshot>[0] = {
      dataFolder: '/game/Data', gameRelease: 'Fallout4',
      places: [], mods: [],
      statCache: '/mo2/stat-cache',
      plugins: [{
        name: 'A.esp', path: '/a/A.esp', origin: 'ModA', provider: { kind: 'Game' }, line: 0, lineNamesIt: true,
        archives: ['/a/A - Main.ba2'], stringsFiles: ['/a/A_en.STRINGS'],
      }],
      active: [], loadedWithNoLine: [],
      archives: ['/g/Interface.ba2', '/a/A - Main.ba2'], stringsFiles: ['/t/A_en.STRINGS'],
    };

    const stamped = await stampedSnapshot(value, stampOf);

    expect(stamped).toEqual({
      ...value,
      plugins: [{
        ...value.plugins.at(0),
        archives: [{ path: '/a/A - Main.ba2', stamp: '15/1/2' }],
        stringsFiles: [{ path: '/a/A_en.STRINGS', stamp: 'EACCES /a/A_en.STRINGS' }],
      }],
      archives: [{ path: '/g/Interface.ba2', stamp: '16/1/2' }, { path: '/a/A - Main.ba2', stamp: '15/1/2' }],
      stringsFiles: [{ path: '/t/A_en.STRINGS', stamp: 'EACCES /t/A_en.STRINGS' }],
    });
    expect(asked.sort()).toEqual(['/a/A - Main.ba2', '/a/A_en.STRINGS', '/g/Interface.ba2', '/t/A_en.STRINGS']);
  });

  it('carries the game folder\'s dataFolder, and every plugin with its origin and path', () => {
    const a = row('a.esp', 'ModA', 0);
    const stray = row('stray.esp', 'ModS', null);

    expect(snapshotOf([a, stray])).toMatchObject({ dataFolder: DATA_FOLDER, plugins: [A_SENT, {
      name: 'stray.esp', path: '/mods/ModS/stray.esp', origin: 'ModS', line: null, lineNamesIt: false, archives: [], stringsFiles: [],
      provider: { kind: 'Mod', mod: 'ModS', folder: '/mo2/mod-folders/ModS', sourceFolder: '/mo2/source/ModS' },
    }] });
  });

  it('sends as active the winning plugin of each enabled line, in line order rather than the value\'s row order, with no disabled or overridden row slipping in', () => {
    const first = row('first.esp', 'ModF', 0);
    const second = row('second.esp', 'ModS', 1);
    const disabled = row('disabled.esp', 'ModD', 2, { enabled: false });
    const overridden = row('second.esp', 'ModO', 1, { winning: false });
    const unlisted = row('unlisted.esp', 'ModU', null, { enabled: false });

    expect(snapshotOf([second, disabled, overridden, unlisted, first])?.active).toEqual([address(first), address(second)]);
  });

  it('sends each plugin\'s plugins.txt line, an overridden plugin at its name\'s line, and none for a plugin no line names', () => {
    const disabled = row('disabled.esp', 'ModD', 2, { enabled: false });
    const overridden = row('second.esp', 'ModO', 1, { winning: false });
    const unlisted = row('unlisted.esp', 'ModU', null, { enabled: false });

    expect(snapshotOf([disabled, overridden, unlisted])?.plugins.map((p) => p.line)).toEqual([2, 1, null]);
  });

  it('says which copy of a filename its line names: the one the Mod override order resolves the name to', () => {
    const overridden = row('second.esp', 'ModO', 1, { winning: false, enabled: false });
    const named = row('second.esp', 'ModS', 1, { enabled: false });

    expect(snapshotOf([overridden, named])?.plugins.map((p) => [p.origin, p.lineNamesIt])).toEqual([['ModO', false], ['ModS', true]]);
  });

  it('sends a disabled mod\'s plugin in plugins, never in active, since it never wins', () => {
    const a = row('a.esp', 'ModA', 0);
    const disabledModPlugin = row('off.esp', 'ModOff', null, { enabled: false, winning: false });

    const snapshot = snapshotOf([a, disabledModPlugin]);

    expect(snapshot?.plugins).toContainEqual({
      name: 'off.esp', path: '/mods/ModOff/off.esp', origin: 'ModOff', line: null, lineNamesIt: false, archives: [], stringsFiles: [],
      provider: { kind: 'Mod', mod: 'ModOff', folder: '/mo2/mod-folders/ModOff', sourceFolder: '/mo2/source/ModOff' },
    });
    expect(snapshot?.active).toEqual([address(a)]);
  });

  it('loads the plugins the game loads with no line first, from the game folder, in the order given', () => {
    const a = row('a.esp', 'ModA', 0);

    const snapshot = snapshotOf([a], [inGameFolder('Master.esm'), inGameFolder('cc.esl')]);

    expect(snapshot?.active).toEqual([
      { name: 'Master.esm', origin: 'Data/' }, { name: 'cc.esl', origin: 'Data/' }, address(a),
    ]);
    expect(snapshot?.plugins).toContainEqual({ name: 'Master.esm', origin: 'Data/', path: join(DATA_FOLDER, 'Master.esm'), provider: { kind: 'Game' }, line: null, lineNamesIt: false, archives: [], stringsFiles: [] });
    expect(snapshot?.loadedWithNoLine).toEqual([{ name: 'Master.esm', origin: 'Data/' }, { name: 'cc.esl', origin: 'Data/' }]);
  });

  it('sends a plugin the game loads with no line as the mod the Mod override order resolves its name to, once', () => {
    const provided = row('Master.esm', 'ModM', null, { enabled: false });

    const snapshot = snapshotOf([provided], [{ ...address(provided), path: provided.path }]);

    expect(snapshot?.active).toEqual([address(provided)]);
    expect(snapshot?.loadedWithNoLine).toEqual([address(provided)]);
    expect(snapshot?.plugins).toEqual([{
      name: 'Master.esm', path: '/mods/ModM/Master.esm', origin: 'ModM', line: null, lineNamesIt: false, archives: [], stringsFiles: [],
      provider: { kind: 'Mod', mod: 'ModM', folder: '/mo2/mod-folders/ModM', sourceFolder: '/mo2/source/ModM' },
    }]);
  });

  it('loads with no line the plugin the game\'s list names, not one whose name differs from it only in case', () => {
    const named = row('Master.esm', 'ModM', null, { enabled: false });
    const twin = row('master.esm', 'ModM', null, { enabled: false, winning: false });

    expect(snapshotOf([named, twin], [{ ...address(named), path: named.path }])?.active).toEqual([address(named)]);
  });

  it('names what provides each plugin: its mod with the mod\'s own folder, not the plugin\'s directory, and its source folder, the game for Data, no mod for overwrite', () => {
    const inMod = row('a.esp', 'ModA', 0);
    const inGame = { ...row('b.esp', 'Data/', 1), path: '/game/Data/b.esp' };
    const stray = { ...row('c.esp', 'overwrite/', null), path: '/instance/overwrite/c.esp' };

    const providers = snapshotOf([inMod, inGame, stray])?.plugins.map((p) => p.provider);

    expect(providers).toEqual([{ kind: 'Mod', mod: 'ModA', folder: '/mo2/mod-folders/ModA', sourceFolder: '/mo2/source/ModA' }, { kind: 'Game' }, { kind: 'None' }]);
  });

  it('names each mod and separator of the mod order that has a folder, a separator by the mod manager\'s name for it, with their metadata files, and the stat cache\'s folder', () => {
    const withSeparator = modFoldersOf('ModA');
    const all = [...withSeparator.all, { kind: 'separator' as const, name: 'Weapons', path: '/mo2/mod-folders/Weapons_separator', modName: 'Weapons_separator' }];
    const outcome = loadOrderSnapshotOf({
      plugins: [], gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine: [], modFolders: { all, holding: (entry) => all.find((f) => f.kind === entry.kind && f.name === entry.name) },
      sourceDirs, places: [], archives: NO_ARCHIVES,
      modlist: {
        ...NO_MODLIST,
        mods: [
          { kind: 'mod', name: 'ModA', enabled: false }, { kind: 'separator', name: 'Weapons', enabled: true },
          { kind: 'separator', name: 'Gone', enabled: true }, { kind: 'mod', name: 'ModGone', enabled: true },
        ],
      },
    });

    expect(outcome).toMatchObject({
      mods: [
        { name: 'ModA', folder: '/mo2/mod-folders/ModA', metadataFiles: ['meta.ini'] },
        { name: 'Weapons_separator', folder: '/mo2/mod-folders/Weapons_separator', metadataFiles: ['meta.ini'] },
      ],
      statCache: '/mo2/stat-cache',
    });
  });

  it('carries the places it is handed', () => {
    const place = { name: 'ModA', folder: '/mo2/mod-folders/ModA' };
    const outcome = loadOrderSnapshotOf({
      plugins: [], gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine: [], modFolders, sourceDirs, places: [place], modlist: NO_MODLIST, archives: NO_ARCHIVES,
    });

    expect(outcome).toMatchObject({ places: [place] });
  });

  it('names no source folder for a mod that is no source mod', () => {
    const outcome = loadOrderSnapshotOf({
      plugins: [row('a.esp', 'ModA', 0)], gameFolder: GAME_FOLDER, pluginsLoadedWithNoLine: [], modFolders, sourceDirs: new Map(), places: [], modlist: NO_MODLIST, archives: NO_ARCHIVES,
    });

    expect(outcome).toMatchObject({ plugins: [{ provider: { kind: 'Mod', mod: 'ModA', folder: '/mo2/mod-folders/ModA' } }] });
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
    const unresolved = { name: 'b.esp', path: undefined, origin: 'Data/', line: 1, enabled: true, winning: true };

    const snapshot = snapshotOf([a, unresolved]);

    expect(snapshot?.plugins).toEqual([A_SENT]);
    expect(snapshot?.active).toEqual([address(a)]);
  });
});
