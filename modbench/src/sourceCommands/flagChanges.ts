// modlist-repository.md, Update manifest, story 7: a plugin no package holds, which is a package's copy once its load
// flags are flipped, is recorded as that copy with the flags set apart.

import type { FlagVariantsOf } from '../manifestAdapter/manifestAdapter';
import { isPluginFile } from '../tables/pluginFile';
import type { HashedModFile } from './manifestBuilder';

/** Each of `files` named in `unheld` that is a package's copy with flags flipped, as the file with the copy's hash and the
 *  flags it sets. `diskPathOf` is where the folder holds a file by its own path. */
export async function flagChangesIn(
  variantsOf: FlagVariantsOf, files: readonly HashedModFile[], unheld: readonly string[], packageHashes: ReadonlySet<string>,
  diskPathOf: (path: string) => string,
): Promise<ReadonlyMap<string, HashedModFile>> {
  const candidates = files.filter(({ path }) => unheld.includes(path) && isPluginFile(path));
  if (candidates.length === 0) return new Map();
  const variants = await variantsOf(candidates.map(({ path }) => diskPathOf(path)));
  return new Map(candidates.flatMap((file) => {
    const copy = variants.get(diskPathOf(file.path))?.find(({ hash }) => packageHashes.has(hash));
    if (copy === undefined) return [];
    const flags = Object.fromEntries(Object.entries(copy.flags).map(([name, on]) => [name, !on]));
    return [[file.path, { path: file.path, hash: copy.hash, flags }] as const];
  }));
}
