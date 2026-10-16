import { FileConflictLookup } from '../../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../../instanceLoader/instance';
import { groupModOrder } from '../../instanceAdapter/modGroups';
import { nexusDomainForMetaGame } from '../../tables/gamePaths';
import { GAME_FOLDER_NOT_FOUND } from './gameFolderNotFound';

/** A whole `InstanceValue` at its neutral value, every field overridable — so a test caring
 *  about one field (`.plugins`, `.downloads`, …) states only that one, typed, with no cast. */
export function instanceValueFixture(overrides: Partial<InstanceValue> = {}): InstanceValue {
  const base: Omit<InstanceValue, 'modGroups' | 'modNames'> = {
    mods: [],
    modFolders: [],
    trackedMods: new Set(),
    sourceMods: new Set(),
    holdsRepository: false,
    profiles: ['Default'],
    files: new FileConflictLookup(),
    filesByMod: new Map(),
    foldersByMod: new Map(),
    plugins: [],
    downloads: { kind: 'listed', rows: [] },
    activeProfile: 'Default',
    managerNames: { manager: 'MO2', modOrderFile: 'modlist.txt', downloadMetadataFile: '.meta' },
    gameName: 'Fallout 4',
    gameRelease: 'Fallout4',
    nexusDomainOf: nexusDomainForMetaGame,
    gameFolder: GAME_FOLDER_NOT_FOUND,
    dataFolderPlugins: { kind: 'unresolved' },
    pluginsLoadedWithNoLine: undefined,
    loadOrderSnapshot: undefined,
    overwriteFiles: [],
    overwriteFolders: [],
    paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map(), sourceDirs: new Map() },
  };
  const value = { ...base, ...overrides };
  const modGroups = groupModOrder(value.mods);
  const modNames = overrides.modNames ?? new Map(value.mods.flatMap((entry) => {
    const folder = value.modFolders?.find(({ kind, name }) => kind === entry.kind && name === entry.name);
    const modName = folder?.modName ?? (entry.kind === 'mod' ? entry.name : undefined);
    return modName === undefined ? [] : [[`${entry.kind}:${entry.name}`, modName] as const];
  }));
  return { ...value, modGroups, modNames, ...overrides };
}
