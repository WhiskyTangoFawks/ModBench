import { FileConflictLookup } from '../../instance/fileConflictIndex';
import type { InstanceValue } from '../../instance/instance';

/** A whole `InstanceValue` at its neutral value, every field overridable — so a test caring
 *  about one field (`.plugins`, `.downloads`, …) states only that one, typed, with no cast. */
export function instanceValueFixture(overrides: Partial<InstanceValue> = {}): InstanceValue {
  return {
    mods: [],
    unlistedFolders: [],
    modFolders: [],
    profiles: ['Default'],
    files: new FileConflictLookup(),
    filesByMod: new Map(),
    plugins: [],
    downloads: [],
    activeProfile: 'Default',
    gameRelease: 'Fallout4',
    gameDirectory: undefined,
    dataFolderPlugins: undefined,
    deployed: false,
    modStatuses: new Map(),
    overwriteFileCount: 0,
    paths: { overwriteDir: '', downloadsDir: '', modDirs: new Map() },
    ...overrides,
  };
}
