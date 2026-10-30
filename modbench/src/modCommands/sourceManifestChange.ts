// mods.md, A source mod, story 2: rename and exclude or include write a source mod's manifest with its folder, so the folder
// already equals the next build's output.

import { lineAtFolderPath, sourceManifestIn, writeSourceManifestIn, type Manifest } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';

/** The output folder's new name, or the paths in the mod folder to exclude from the build or include again under the mod
 *  manager's exclusion mark. */
export type SourceManifestChange =
  | { readonly output: string }
  | { readonly exclude: readonly string[]; readonly include: readonly string[]; readonly exclusionMark: string };

const folded = (path: string): string => path.toLowerCase();

function changed(manifest: Manifest, change: SourceManifestChange): Manifest {
  if ('output' in change) return { ...manifest, output: change.output };
  const including = new Set(change.include.map(folded));
  const kept = manifest.exclude.filter((path) => !including.has(folded(path)));
  const exclude = [...kept, ...change.exclude.filter((path, at) =>
    !kept.some((one) => folded(one) === folded(path)) && change.exclude.findIndex((one) => folded(one) === folded(path)) === at)];
  const excluding = { ...manifest, exclude };
  return { ...excluding, files: manifest.files.map((line) => lineAtFolderPath(excluding, line, change.exclusionMark)) };
}

/** Writes the change into the manifest of the source mod's repository in `sourceFolder`, keeping all else it says; why it
 *  wrote nothing, if so. */
export async function changeSourceManifest(sourceFolder: string, change: SourceManifestChange): Promise<string | undefined> {
  try {
    const held = await sourceManifestIn(sourceFolder);
    if (held === undefined) return `"${sourceFolder}" holds no manifest.`;
    if ('refused' in held) return `The source mod in "${sourceFolder}" was not changed: ${held.refused}.`;
    await writeSourceManifestIn(sourceFolder, changed(held.manifest, change));
    return undefined;
  } catch (err) {
    return `The manifest in "${sourceFolder}" could not be written: ${errorMessage(err)}`;
  }
}
