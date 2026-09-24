import { FileConflictLookup } from '../../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../../instanceLoader/instance';
import { GAME_FOLDER_NOT_FOUND } from './gameFolderNotFound';

/** A whole `InstanceValue` at its neutral value, every field overridable — so a test caring
 *  about one field (`.plugins`, `.downloads`, …) states only that one, typed, with no cast. */
export function instanceValueFixture(overrides: Partial<InstanceValue> = {}): InstanceValue {
  return {
    mods: [],
    modFolders: [],
    profiles: ['Default'],
    files: new FileConflictLookup(),
    filesByMod: new Map(),
    plugins: [],
    downloads: { kind: 'listed', rows: [] },
    activeProfile: 'Default',
    gameRelease: 'Fallout4',
    nexusSlug: 'fallout4',
    gameFolder: GAME_FOLDER_NOT_FOUND,
    dataFolderPlugins: { kind: 'unresolved' },
    modStatuses: new Map(),
    overwriteFileCount: 0,
    paths: { overwriteDir: '', downloadsDir: '', modDirs: new Map() },
    ...overrides,
  };
}
