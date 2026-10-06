import { FileConflictLookup } from '../../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../../instanceLoader/instance';
import { modSyncArgumentsOf, pluginSyncArgumentsOf } from '../../instanceLoader/syncArguments';
import { GAME_FOLDER_NOT_FOUND } from './gameFolderNotFound';

/** A whole `InstanceValue` at its neutral value, every field overridable — so a test caring
 *  about one field (`.plugins`, `.downloads`, …) states only that one, typed, with no cast. */
export function instanceValueFixture(overrides: Partial<InstanceValue> = {}): InstanceValue {
  const base: Omit<InstanceValue, 'modSyncArguments' | 'pluginSyncArguments'> = {
    mods: [],
    modFolders: [],
    trackedMods: new Set(),
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
    nexusSlug: 'fallout4',
    gameFolder: GAME_FOLDER_NOT_FOUND,
    dataFolderPlugins: { kind: 'unresolved' },
    pluginsLoadedWithNoLine: undefined,
    loadOrderSnapshot: undefined,
    overwriteFiles: [],
    overwriteFolders: [],
    paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map() },
  };
  const value = { ...base, ...overrides };
  return { ...value, modSyncArguments: modSyncArgumentsOf(value), pluginSyncArguments: pluginSyncArgumentsOf({ ...value, pluginLines: [] }), ...overrides };
}
