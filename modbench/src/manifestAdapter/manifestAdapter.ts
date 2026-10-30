export type * from './manifest';
export {
  folderAgainst, metadataOf, metadataOverwritten, statusOf, statusesNow, type FolderAgainst, type FolderReads, type ModAt, type ModStatus,
} from './modStatus';
export { ordinal, ordinalIgnoreCaseThenOrdinal, pinText } from './manifestText';
export { manifestIn, removeManifestIn, sourceManifestFile, sourceManifestIn, writeManifestIn, writeSourceManifestIn } from './manifestFiles';
export { lineAtFolderPath } from './folderPaths';
export { packageOf } from './packageOf';
