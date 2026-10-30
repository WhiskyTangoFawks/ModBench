export const MANIFEST_SUFFIX = '.manifest.json';

/** Whether `path`, from a mod folder's root, is the folder's manifest: a folder renamed outside Modbench holds it under the
 *  name it had (mods.md, Build, story 4). */
export const isManifestPath = (path: string): boolean => !path.includes('/') && path.toLowerCase().endsWith(MANIFEST_SUFFIX);
