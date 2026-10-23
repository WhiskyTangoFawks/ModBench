import { FileConflictLookup } from '../../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../../instanceLoader/instance';
import { groupModOrder } from '../../instanceAdapter/modGroups';
import { modOfOrigin } from '../../instanceLoader/modOfOrigin';
import { entryKey } from '../../instanceAdapter/mo2/mo2Context';
import { nexusDomainForMetaGame } from '../../tables/gamePaths';
import { GAME_FOLDER_NOT_FOUND } from './gameFolderNotFound';

/** A whole `InstanceValue` at its neutral value, every field overridable — so a test caring
 *  about one field (`.plugins`, `.downloadedFiles`, …) states only that one, typed, with no cast. */
export function instanceValueFixture(overrides: Partial<InstanceValue> = {}): InstanceValue {
  const base: Omit<InstanceValue, 'modGroups' | 'modNames'> = {
    mods: [],
    modFolders: [],
    listedSourceMods: new Set(),
    sourceMods: new Set(),
    holdsRepository: false,
    repositorySetUp: false,
    profiles: ['Default'],
    files: new FileConflictLookup(),
    filesByMod: new Map(),
    foldersByMod: new Map(),
    plugins: [],
    downloadedFiles: { kind: 'listed', rows: [] },
    activeProfile: 'Default',
    managerNames: { manager: 'MO2', modOrderFile: 'modlist.txt', downloadedFileMetadataFile: '.meta' },
    managerRunning: { kind: 'notRunning' },
    gameName: 'Fallout 4',
    nexusDomainOf: nexusDomainForMetaGame,
    entryKey,
    gameFolder: GAME_FOLDER_NOT_FOUND,
    dataFolderPlugins: { kind: 'unresolved' },
    pluginsLoadedWithNoLine: undefined,
    loadOrderSnapshot: undefined,
    overwriteFiles: [],
    overwriteFolders: [],
    paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map(), sourceDirs: new Map() },
    publisherTags: [],
    publisherConfiguration: { kind: 'none' },
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

/** `modOfOrigin` over a mod order of the named mods, as the instance value answers it. */
export const modOfOriginIn = (...mods: readonly string[]): ((origin: string) => string | undefined) => {
  const value = instanceValueFixture({ mods: mods.map((name) => ({ kind: 'mod' as const, name, enabled: true })) });
  return (origin) => modOfOrigin(value, origin)?.name;
};
